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

  console.log("=== Parsed Calendar Fields ===");
  console.log("UID:", uid);
  console.log("DTSTART:", dtstart);
  console.log("DTEND:", dtend);
  console.log("MEETING_URL:", meetingUrl);
  console.log("ATTENDEES:", attendees);
  console.log("=== End Parsed Fields ===");

  // ✅ Send parsed data to Base44
  const base44Url = "https://hostwell.app/api/webhooks/inbound-calendar";

  const payload = {
    source: "postmark",
    to: body.To,
    subject: body.Subject,
    uid,
    dtstart,
    dtend,
    meetingUrl,
    attendees
  };

  try {
    const r = await fetch(base44Url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    console.log("=== Base44 webhook response ===");
    console.log("Status:", r.status);
    console.log("Body:", text.slice(0, 500));
    console.log("=== End Base44 response ===");
  } catch (err) {
    console.log("ERROR posting to Base44:", err?.message || err);
  }

  res.status(200).json({ ok: true });
}
