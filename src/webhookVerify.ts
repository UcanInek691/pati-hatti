export interface VerifyResult {
  status: 200 | 400 | 403;
  body: string;
}

/** Meta WhatsApp webhook handshake (GET /webhooks/whatsapp). */
export function verifyWhatsAppChallenge(params: URLSearchParams, expectedToken: string): VerifyResult {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (!mode || !token || !challenge) {
    console.log("whatsapp webhook verify: missing params", { mode: mode ?? null });
    return { status: 400, body: "Bad Request" };
  }

  const success = mode === "subscribe" && token === expectedToken;
  console.log("whatsapp webhook verify:", success ? "accepted" : "rejected", { mode });

  if (!success) {
    return { status: 403, body: "Forbidden" };
  }

  return { status: 200, body: challenge };
}
