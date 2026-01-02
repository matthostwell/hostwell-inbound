function decodeBase64ToUtf8(b64) {
  return Buffer.from(b64, "base64").toString("utf8");
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
    console.log("=== ICS (first 1200 chars) ===");
    console.log(icsText.slice(0, 1200));
    console.log("=== END ICS PREVIEW ===");
  } else {
    console.log("No ICS attachment found.");
  }

  res.status(200).json({ ok: true });
}
