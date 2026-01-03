function decodeBase64ToUtf8(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

// Try multiple patterns to find a join link across Meet/Zoom/Teams
function extractMeetingUrl(icsText) {
  const urlLine = firstMatch(icsText, /^URL:(.+)$/m);
  if (urlLine && urlLine.startsWith("http")) return urlLine;

  const meet = firstMatch(icsText, /(https:\/\/meet\.google\.com\/[a-z0-9-]+)/i);
  if (meet) return meet;

  const zoom = firstMatch(
    icsText,
    /(https:\/\/[a-z0-9.-]*zoom\.us\/j\/\d+(\?[^\s\r\n]+)?)/i
  );
  if (zoom) return zoom;

  const teams = firstMatch(
    icsText,
    /(https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s\r\n]+)/i
  );
  if (teams) return teams;

  const any = firstMatch(icsText, /(https:\/\/[^\s\r\n]+)/i);
  if (any) return any;

  return null;
}

function inferPlatformType(meetingUrl) {
  const u = (meetingUrl || "").toLowerCase();
  if (u.includes("meet.google.com")) return "google_meet";
  if (u.includes("zoom.us")) return "zoom";
  if (u.includes("teams.microsoft.com")) return "microsoft_teams";
  return meetingUrl ? "unknown" : null;
}

// Extract attendee emails from lines like:
// ATTENDEE;CN=Name;...:mailto:person@company.com
function extractAttendees(icsText) {
  const attendees = new Set();
  const re = /^ATTENDEE(?:;[^:]*)?:mailto:([^\r\n]+)/gim;
  let m;
  while ((m = re.exec(icsText)) !== null) {
    const email = (m[1] || "").trim().toLowerCase();
    if (email) attendees.add(email);
  }
  return Array.from(attendees);
}

function extractOrganizerEmail(icsText) {
  // ORGANIZER;CN=Name:mailto:someone@domain.com
  const org = firstMatch(icsText, /^ORGANIZER(?:;[^:]*)?:mailto:([^\r\n]+)$/im);
  return org ? org.trim().toLowerCase() : null;
}

async function base44Fetch(path, { method = "GET", body } = {}) {
  const appId = process.env.BASE44_APP_ID;
  const apiKey = process.env.BASE44_API_KEY;

  if (!appId || !apiKey) {
    throw new Error("Missing BASE44_APP_ID or BASE44_API_KEY in Vercel env vars");
  }

  const url = `https://app.base44.com/api/apps/${appId}${path}`;

  const headers = {
    api_key: apiKey,
    "Content-Type": "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // keep json as null
  }

  return { res, text, json, url };
}

// Best-effort “find by filter” helper.
// Base44’s API page lists “Filterable fields”, and commonly supports query params like ?field=value.
async function base44FindOne(entityName, field, value) {
  if (!value) return null;

  const qs = new URLSearchParams({ [field]: value }).toString();
  const { res, json, text, url } = await base44Fetch(`/entities/${entityName}?${qs}`);

  if (!res.ok) {
    console.log(`Base44 findOne ${entityName} failed`, res.status, url, text.slice(0, 300));
    return null;
  }

  // Base44 may return { data: [...] } or just [...]
  const list = Array.isArray(json) ? json : (json?.data || json?.items || []);
  return list?.[0] || null;
}

async function base44Create(entityName, data) {
  const { res, json, text, url } = await base44Fetch(`/entities/${entityName}`, {
    method: "POST",
    body: data,
  });

  if (!res.ok) {
    console.log(`Base44 create ${entityName} failed`, res.status, url, text.slice(0, 500));
    return null;
  }

  return json?.data || json;
}

async function base44Update(entityName, id, data) {
  const { res, json, text, url } = await base44Fetch(`/entities/${entityName}/${id}`, {
    method: "PUT",
    body: data,
  });

  if (!res.ok) {
    console.log(`Base44 update ${entityName} failed`, res.status, url, text.slice(0, 500));
    return null;
  }

  return json?.data || json;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  const body = req.body || {};
  const attachments = body.Attachments || [];

  console.log("=== Postmark Inbound Received ===");
  console.log("To:", body.To);
  console.log("Subject:", body.Subject);
  console.log("Attachment count:", attachments.length);

  const cal = attachments.find(a =>
    (a.ContentType || "").toLowerCase().includes("text/calendar") ||
    (a.Name || "").toLowerCase().endsWith(".ics")
  );

  if (!cal?.Content) {
    console.log("No ICS attachment found.");
    res.status(200).json({ ok: true });
    return;
  }

  const icsText = decodeBase64ToUtf8(cal.Content);

  const uid = firstMatch(icsText, /^UID:(.+)$/m);
  const dtstart = firstMatch(icsText, /^DTSTART(?:;[^:]*)?:(.+)$/m);
  const dtend = firstMatch(icsText, /^DTEND(?:;[^:]*)?:(.+)$/m);
  const meetingUrl = extractMeetingUrl(icsText);
  const attendees = extractAttendees(icsText);
  const organizerEmail = extractOrganizerEmail(icsText);
  const platformType = inferPlatformType(meetingUrl);

  console.log("=== Parsed Calendar Fields ===");
  console.log("UID:", uid);
  console.log("DTSTART:", dtstart);
  console.log("DTEND:", dtend);
  console.log("MEETING_URL:", meetingUrl);
  console.log("ATTENDEES:", attendees);
  console.log("ORGANIZER:", organizerEmail);
  console.log("PLATFORM:", platformType);
  console.log("=== End Parsed Fields ===");

  // ---- Write to Base44 Entities API ----
  try {
    // 1) Upsert Meeting by calendarEventUid
    const existingMeeting = await base44FindOne("Meeting", "calendarEventUid", uid);

    const meetingData = {
      calendarEventUid: uid,
      startTime: dtstart,
      endTime: dtend,
      platformMeetingUrl: meetingUrl,
      organizerEmail: organizerEmail,
      meetingTitle: body.Subject || null,
      platformType: platformType,
      sourceType: "calendar",
      lastCalendarUpdateAt: new Date().toISOString(),
    };

    const meeting =
      existingMeeting?.id
        ? await base44Update("Meeting", existingMeeting.id, meetingData)
        : await base44Create("Meeting", meetingData);

    const meetingId = meeting?.id || meeting?.data?.id || meeting?.entity?.id;

    console.log("Base44 Meeting ID:", meetingId);

    // 2) Upsert Guests by email, then link MeetingGuest
    if (meetingId && Array.isArray(attendees)) {
      for (const email of attendees) {
        const existingGuest = await base44FindOne("Guest", "email", email);

        const guest =
          existingGuest?.id
            ? existingGuest
            : await base44Create("Guest", { email });

        const guestId = guest?.id || guest?.data?.id;

        if (!guestId) continue;

        // Link table (best effort). If your MeetingGuest entity uses different field names,
        // we’ll adjust after we see one response.
        // Try to avoid duplicates by searching first.
        const existingLink = await base44FindOne("MeetingGuest", "meetingId", meetingId);
        // If that filter is too broad, it will just create duplicates; we’ll refine next step.

        if (!existingLink) {
          await base44Create("MeetingGuest", {
            meetingId,
            guestId,
            guestEmail: email,
          });
        }
      }
    }

    console.log("=== Base44 write complete ===");
  } catch (err) {
    console.log("ERROR writing to Base44:", err?.message || err);
  }

  // Always respond 200 so Postmark doesn’t retry endlessly during early dev
  res.status(200).json({ ok: true });
}
