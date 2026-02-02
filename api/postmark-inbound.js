function decodeBase64ToUtf8(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

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
  if (u.includes("meet.google.com")) return "meet";
  if (u.includes("zoom.us")) return "zoom";
  if (u.includes("teams.microsoft.com")) return "teams";
  return meetingUrl ? "unknown" : "unknown";
}

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
  const org = firstMatch(icsText, /^ORGANIZER(?:;[^:]*)?:mailto:([^\r\n]+)$/im);
  return org ? org.trim().toLowerCase() : null;
}

function extractCalendarMethod(icsText) {
  return firstMatch(icsText, /^METHOD:(.+)$/m) || null;
}

// Parses common DTSTART formats like:
// 20260116T230000Z
// 20260116T230000
// 20260116
function icsDateToIso(icsVal) {
  if (!icsVal) return null;
  const v = icsVal.trim();

  // Date only YYYYMMDD
  if (/^\d{8}$/.test(v)) {
    const y = v.slice(0, 4);
    const mo = v.slice(4, 6);
    const d = v.slice(6, 8);
    return new Date(`${y}-${mo}-${d}T00:00:00Z`).toISOString();
  }

  // Date-time YYYYMMDDTHHMMSS(Z optional)
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (m) {
    const [_, y, mo, d, hh, mm, ss, z] = m;
    const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}${z ? "Z" : "Z"}`;
    // Treat non-Z as UTC for now (good enough for MVP).
    return new Date(iso).toISOString();
  }

  // Fallback: try Date parse
  const dt = new Date(v);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

// Extract join_token from inbound "To" like:
// "meet+abc123@meet.hostwell.app"
function extractJoinToken(toField) {
  const s = (toField || "").toString().toLowerCase();
  const m = s.match(/meet\+([a-z0-9-_]+)@/i);
  return m ? m[1] : null;
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
  } catch {}

  return { res, text, json, url };
}

async function base44FindOne(entityName, field, value) {
  if (!value) return null;

  const qs = new URLSearchParams({ [field]: value }).toString();
  const { res, json, text, url } = await base44Fetch(`/entities/${entityName}?${qs}`);

  if (!res.ok) {
    console.log(`Base44 findOne ${entityName} failed`, res.status, url, text.slice(0, 300));
    return null;
  }

  const list = Array.isArray(json) ? json : (json?.data || json?.items || []);
  return list?.[0] || null;
}

async function base44Create(entityName, data) {
  const { res, json, text, url } = await base44Fetch(`/entities/${entityName}`, {
    method: "POST",
    body: data,
  });

  if (!res.ok) {
    console.log(`Base44 create ${entityName} failed`, res.status, url, text.slice(0, 800));
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
    console.log(`Base44 update ${entityName} failed`, res.status, url, text.slice(0, 800));
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

  const join_token = extractJoinToken(body.To);

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
  const dtstartRaw = firstMatch(icsText, /^DTSTART(?:;[^:]*)?:(.+)$/m);
  const dtendRaw = firstMatch(icsText, /^DTEND(?:;[^:]*)?:(.+)$/m);

  const startIso = icsDateToIso(dtstartRaw);
  const endIso = icsDateToIso(dtendRaw);

  const meetingUrl = extractMeetingUrl(icsText);
  const attendees = extractAttendees(icsText);
  const organizerEmail = extractOrganizerEmail(icsText);
  const platformType = inferPlatformType(meetingUrl);
  const calendarMethod = extractCalendarMethod(icsText);

  // Base44 required fields
  const title = (body.Subject || "").trim() || "Hostwell Meeting";
  const scheduled_date = startIso; // required date-time

  console.log("=== Parsed Calendar Fields ===");
  console.log("join_token:", join_token);
  console.log("UID:", uid);
  console.log("DTSTART raw:", dtstartRaw);
  console.log("DTEND raw:", dtendRaw);
  console.log("startIso:", startIso);
  console.log("endIso:", endIso);
  console.log("MEETING_URL:", meetingUrl);
  console.log("ATTENDEES:", attendees);
  console.log("ORGANIZER:", organizerEmail);
  console.log("PLATFORM:", platformType);
  console.log("METHOD:", calendarMethod);
  console.log("=== End Parsed Fields ===");

  try {
    // Upsert Meeting by calendarEventUid (best key)
    const existingMeeting = await base44FindOne("Meeting", "calendarEventUid", uid);

    const meetingData = {
      // required
      title,
      scheduled_date,
      join_token,

      // helpful
      sourceType: "calendar_email",
      calendarEventUid: uid,
      calendarMethod,
      organizerEmail,
      startTime: startIso,
      endTime: endIso,
      meetingTitle: title,
      platformType,
      platformMeetingUrl: meetingUrl,
      meeting_url: meetingUrl,
      lastCalendarUpdateAt: new Date().toISOString(),
      status: calendarMethod === "CANCEL" ? "canceled" : "scheduled"
    };

    const meeting =
      existingMeeting?.id
        ? await base44Update("Meeting", existingMeeting.id, meetingData)
        : await base44Create("Meeting", meetingData);

    const meetingId = meeting?.id || meeting?.data?.id;

    console.log("Base44 Meeting ID:", meetingId);

    // For now: just log attendees. We’ll wire Guest + MeetingGuest next once Meeting write is confirmed.
    console.log("Attendees to link next:", attendees);
  } catch (err) {
    console.log("ERROR writing Meeting to Base44:", err?.message || err);
  }

  res.status(200).json({ ok: true });
}
