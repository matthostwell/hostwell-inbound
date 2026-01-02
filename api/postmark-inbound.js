export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method Not Allowed" });
    return;
  }

  console.log("=== Postmark Inbound Received ===");
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);

  res.status(200).json({ ok: true });
}
