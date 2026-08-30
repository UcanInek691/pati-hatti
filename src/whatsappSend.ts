import type { Env } from "./env";

export type SendWhatsAppTextMessageResult = { kind: "accepted"; providerMessageId: string } | { kind: "failed" };

const FAILED: SendWhatsAppTextMessageResult = { kind: "failed" };
const GRAPH_VERSION_PATTERN = /^v\d+\.0$/;
const PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,64}$/;
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

function isCodePointLengthInRange(value: string, min: number, max: number): boolean {
  const length = [...value].length;
  return length >= min && length <= max;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  try {
    return typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Sends one fixed-copy WhatsApp text message through the Meta Cloud API.
 * Never logs the request/response body, token, recipient, or content.
 */
export async function sendWhatsAppTextMessage(
  phoneNumberId: string,
  recipientE164: string,
  content: string,
  accessToken: string,
  env: Env,
): Promise<SendWhatsAppTextMessageResult> {
  if (!accessToken.trim()) return FAILED;
  if (!GRAPH_VERSION_PATTERN.test(env.WHATSAPP_GRAPH_API_VERSION)) return FAILED;
  if (!PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) return FAILED;
  if (!E164_PATTERN.test(recipientE164)) return FAILED;
  if (!isCodePointLengthInRange(content, 1, 4096)) return FAILED;

  let endpoint: URL;
  try {
    endpoint = new URL(`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${phoneNumberId}/messages`);
  } catch {
    return FAILED;
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipientE164,
        type: "text",
        text: { preview_url: false, body: content },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return FAILED;
  }

  if (!response.ok) return FAILED;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return FAILED;
  }

  try {
    const record = asPlainRecord(payload);
    if (!record) return FAILED;

    const messages = record.messages;
    if (!Array.isArray(messages) || messages.length !== 1) return FAILED;

    const messageRecord = asPlainRecord(messages[0]);
    if (
      !messageRecord ||
      Reflect.ownKeys(messageRecord).some(
        (key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(messageRecord, key),
      )
    ) {
      return FAILED;
    }

    const { id } = messageRecord;
    if (typeof id !== "string" || !isCodePointLengthInRange(id, 1, 512)) return FAILED;

    return { kind: "accepted", providerMessageId: id };
  } catch {
    return FAILED;
  }
}
