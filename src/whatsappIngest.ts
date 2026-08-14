import type { Env } from "./env";
import { resolveWhatsAppContactAutomation } from "./contactAutomation";

const SENDER_PATTERN = /^[1-9]\d{1,14}$/;
const TIMESTAMP_PATTERN = /^[1-9]\d*$/;
const MAX_OWNER_NAME_LENGTH = 200;
const MIN_TEXT_LENGTH = 1;
const MAX_TEXT_LENGTH = 65536;
const MAX_ID_LENGTH = 512;
const FALLBACK_OWNER_NAME = "WhatsApp user";

/**
 * Fixed internal stand-in stored instead of any media payload. Contains no
 * user or provider data. A real text message equal to this exact string is
 * indistinguishable from media downstream and receives the fixed
 * unsupported-media reply; that harmless collision is an accepted MVP ceiling.
 */
export const UNSUPPORTED_MEDIA_MARKER = "__vetai_unsupported_media__";

/** Owner-sent message types accepted into the durable path but never interpreted. Anything else (reaction, system, unknown) is still ignored. */
const UNSUPPORTED_MEDIA_TYPES: ReadonlySet<string> = new Set(["audio", "contacts", "document", "image", "location", "sticker", "video"]);

export interface WhatsAppIngestItem {
  phoneNumberId: string;
  providerMessageId: string;
  senderE164: string;
  ownerName: string;
  messageText: string;
  providerTimestamp: string;
  payloadHash: string;
}

export type ExtractionResult =
  | { ok: true; items: WhatsAppIngestItem[] }
  | { ok: false; reason: "invalid" | "route_failed" };

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
 * Extracts supported inbound messages from a signed, envelope-validated
 * WhatsApp webhook body. Text messages carry their own body; the closed set of
 * unsupported owner media types carries `UNSUPPORTED_MEDIA_MARKER` instead, so
 * nested media fields are never inspected, hashed, or persisted. Status/read
 * events and every other message type are ignored. Returns `{ ok: false }` if
 * any recognized item has malformed required fields, or if a route lookup
 * fails — the caller must reject the whole webhook and persist nothing in
 * that case. Every candidate's route is resolved from envelope fields alone
 * (phone number ID, sender E.164) before any nested text/media field is
 * read; an effective `personal` route skips the candidate entirely, so its
 * nested content is never accessed, hashed, or persisted (Task 033).
 */
export async function extractInboundMessages(body: { entry: unknown[] }, env: Env): Promise<ExtractionResult> {
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

      const phoneNumberId = asRecord(value.metadata)?.phone_number_id;

      for (const message of messages) {
        const messageObj = asRecord(message);
        if (messageObj === null) continue;
        const declaredType = messageObj.type;
        const isText = declaredType === "text";
        if (!isText && !(typeof declaredType === "string" && UNSUPPORTED_MEDIA_TYPES.has(declaredType))) continue;

        if (typeof phoneNumberId !== "string" || phoneNumberId.length < 1 || phoneNumberId.length > MAX_ID_LENGTH) {
          return { ok: false, reason: "invalid" };
        }

        const id = messageObj.id;
        const from = messageObj.from;
        const timestamp = messageObj.timestamp;

        if (typeof id !== "string" || id.length < 1 || id.length > MAX_ID_LENGTH) return { ok: false, reason: "invalid" };
        if (typeof from !== "string" || !SENDER_PATTERN.test(from)) return { ok: false, reason: "invalid" };
        if (typeof timestamp !== "string" || !TIMESTAMP_PATTERN.test(timestamp)) return { ok: false, reason: "invalid" };

        const senderE164 = `+${from}`;

        // Route resolution happens here, from envelope fields alone, before any
        // nested text/media field below is read. A failed lookup fails the
        // whole webhook closed; an effective `personal` route skips this
        // candidate without ever touching its content.
        const route = await resolveWhatsAppContactAutomation(phoneNumberId, senderE164, env);
        if (route.kind === "failed") return { ok: false, reason: "route_failed" };
        if (route.kind === "personal") continue;

        let messageText: string;
        if (isText) {
          const text = asRecord(messageObj.text)?.body;
          if (typeof text !== "string") return { ok: false, reason: "invalid" };
          const textLength = Array.from(text).length;
          if (textLength < MIN_TEXT_LENGTH || textLength > MAX_TEXT_LENGTH) return { ok: false, reason: "invalid" };
          messageText = text;
        } else {
          messageText = UNSUPPORTED_MEDIA_MARKER;
        }

        const timestampSeconds = Number(timestamp);
        if (!Number.isSafeInteger(timestampSeconds)) return { ok: false, reason: "invalid" };
        const timestampDate = new Date(timestampSeconds * 1000);
        if (!Number.isFinite(timestampDate.getTime())) return { ok: false, reason: "invalid" };

        const dedupeKey = JSON.stringify([phoneNumberId, id]);
        // Contact/profile fields are intentionally inspected only after the
        // route has proved that this is not a personal candidate.
        const contacts = Array.isArray(value.contacts) ? value.contacts : [];
        let profileName: string | undefined;
        for (const contact of contacts) {
          const contactObj = asRecord(contact);
          if (contactObj?.wa_id !== from) continue;
          const candidateName = asRecord(contactObj.profile)?.name;
          if (typeof candidateName === "string") profileName = candidateName;
          break;
        }
        const trimmedName = profileName?.trim();
        const ownerName = trimmedName ? Array.from(trimmedName).slice(0, MAX_OWNER_NAME_LENGTH).join("") : FALLBACK_OWNER_NAME;
        const providerTimestamp = timestampDate.toISOString();
        const canonicalEvent = isText
          ? JSON.stringify([phoneNumberId, id, senderE164, timestamp, messageText])
          : JSON.stringify([phoneNumberId, id, senderE164, timestamp, messageText, declaredType]);
        const seenEvent = seen.get(dedupeKey);
        if (seenEvent !== undefined) {
          if (seenEvent !== canonicalEvent) return { ok: false, reason: "invalid" };
          continue;
        }
        seen.set(dedupeKey, canonicalEvent);
        const payloadHash = await hashEvent(canonicalEvent);

        items.push({
          phoneNumberId,
          providerMessageId: id,
          senderE164,
          ownerName,
          messageText,
          providerTimestamp,
          payloadHash,
        });
      }
    }
  }

  return { ok: true, items };
}
