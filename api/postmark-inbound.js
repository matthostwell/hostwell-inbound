function decodeBase64ToUtf8(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
}

function firstMatch(icsText, regex) {
  const m = icsText.match(regex);
  return m ? m[1].trim() : null;
}

// Try multiple patterns to find a join link across Meet/Zoom/Teams
function extractMeetingUrl(icsText) {
  // 1) Common: CONFERENCE / URL fields (some providers)
  const urlLine = firstMatch(icsText, /^URL:(.+)$/m);
  if (urlLine && urlLine.startsWith("http")) return urlLine;

  // 2) Google Meet often appears in LOCATION or DESCRIPTION as https://meet.google.com/...
  const meet = firstMatch(icsText, /(https:\/\/meet\.google\.com\/[a-z0-9-]+)/i);
  if (meet) return meet;

  // 3) Zoom links
  const zoom = firstMatch(
    icsText,
    /(https:\/\/[a-z0-9.-]*zoom\.us\/j\/\d+(\?[^\s\r\n]+)?)/i
  );
  if (zoom) return zoom;

  // 4) Microsoft Teams links
  const teams = firstMatch(
    icsText,
    /(https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s\r\n]+)/i
  );
  if (teams) return teams;

  // 5) Generic fallback: first https:// link in the ICS (last resort)
  const any = firstMatch(icsText, /(https:\/\/[^\s\r\n]+)/i);
  if (any) return any;

  return null;
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

  if (cal?.Content) {
    const icsText = decodeBase64ToUtf8(cal.Content);

    const uid = firstMatch(icsText, /^UID:(.+)$/m);
    const dtstart = firstMatch(icsText, /^DTSTART(?:;[^:]*)?:(.+)$/m);
    const dtend = firstMatch(icsText, /^DTEND(?:;[^:]*)?:(.+)$/m);
    const meetingUrl = extractMeetingUrl(icsText);

    console.log("=== Parsed Calendar Fields ===");
    console.log("UID:", uid);
    console.log("DTSTART:", dtstart);
    console.log("DTEND:", dtend);
    console.log("MEETING_URL:", meetingUrl);
    console.log("=== End Parsed Fields ===");
  } else {
    console.log("No ICS attachment found.");
  }

  res.status(200).json({ ok: true });
}
