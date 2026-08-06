const SENDER_PATTERN = /^[1-9]\d{1,14}$/;
const TIMESTAMP_PATTERN = /^[1-9]\d*$/;
const MAX_OWNER_NAME_LENGTH = 200;
const MIN_TEXT_LENGTH = 1;
const MAX_TEXT_LENGTH = 65536;
const MAX_ID_LENGTH = 512;
const FALLBACK_OWNER_NAME = "WhatsApp user";

export interface WhatsAppIngestItem {
  phoneNumberId: string;
  providerMessageId: string;
  senderE164: string;
  ownerName: string;
  messageText: string;
  providerTimestamp: string;
  payloadHash: string;
}

export type ExtractionResult = { ok: true; items: WhatsAppIngestItem[] } | { ok: false };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

async function hashEvent(canonicalEvent: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalEvent));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extracts supported inbound text messages from a signed, envelope-validated
 * WhatsApp webhook body. Status/read events and non-text message types are
 * ignored. Returns `{ ok: false }` if any item declaring `type: "text"` has
 * malformed required fields — the caller must reject the whole webhook and
 * persist nothing in that case.
 */
export async function extractTextMessages(body: { entry: unknown[] }): Promise<ExtractionResult> {
  const items: WhatsAppIngestItem[] = [];
  const seen = new Map<string, string>();

  for (const entry of body.entry) {
    const changes = asRecord(entry)?.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      const changeObj = asRecord(change);
      if (changeObj?.field !== "messages") continue;

      const value = asRecord(changeObj.value);
      if (!value) continue;

      const messages = value.messages;
      if (!Array.isArray(messages)) continue;

      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const nameByWaId = new Map<string, string>();
      for (const contact of contacts) {
        const contactObj = asRecord(contact);
        const waId = contactObj?.wa_id;
        const profileName = asRecord(contactObj?.profile)?.name;
        if (typeof waId === "string" && typeof profileName === "string") {
          nameByWaId.set(waId, profileName);
        }
      }

      const phoneNumberId = asRecord(value.metadata)?.phone_number_id;

      for (const message of messages) {
        const messageObj = asRecord(message);
        if (messageObj?.type !== "text") continue;

        if (typeof phoneNumberId !== "string" || phoneNumberId.length < 1 || phoneNumberId.length > MAX_ID_LENGTH) return { ok: false };

        const id = messageObj.id;
        const from = messageObj.from;
        const timestamp = messageObj.timestamp;
        const text = asRecord(messageObj.text)?.body;

        if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH) return { ok: false };
        if (typeof from !== "string" || !SENDER_PATTERN.test(from)) return { ok: false };
        if (typeof timestamp !== "string" || !TIMESTAMP_PATTERN.test(timestamp)) return { ok: false };
        if (typeof text !== "string") return { ok: false };
        const textLength = Array.from(text).length;
        if (textLength < MIN_TEXT_LENGTH || textLength > MAX_TEXT_LENGTH) return { ok: false };

        const timestampSeconds = Number(timestamp);
        if (!Number.isSafeInteger(timestampSeconds)) return { ok: false };
        const timestampDate = new Date(timestampSeconds * 1000);
        if (!Number.isFinite(timestampDate.getTime())) return { ok: false };

        const dedupeKey = JSON.stringify([phoneNumberId, id]);
        const senderE164 = `+${from}`;
        const trimmedName = nameByWaId.get(from)?.trim();
        const ownerName = trimmedName ? Array.from(trimmedName).slice(0, MAX_OWNER_NAME_LENGTH).join("") : FALLBACK_OWNER_NAME;
        const providerTimestamp = timestampDate.toISOString();
        const canonicalEvent = JSON.stringify([phoneNumberId, id, senderE164, timestamp, text]);
        const seenEvent = seen.get(dedupeKey);
        if (seenEvent !== undefined) {
          if (seenEvent !== canonicalEvent) return { ok: false };
          continue;
        }
        seen.set(dedupeKey, canonicalEvent);
        const payloadHash = await hashEvent(canonicalEvent);

        items.push({
          phoneNumberId,
          providerMessageId: id,
          senderE164,
          ownerName,
          messageText: text,
          providerTimestamp,
          payloadHash,
        });
      }
    }
  }

  return { ok: true, items };
}
