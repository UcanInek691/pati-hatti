const PHONE_NUMBER_ID_PATTERN = /^[0-9]{1,64}$/;
const RECIPIENT_PATTERN = /^[1-9]\d{1,14}$/;
const TIMESTAMP_PATTERN = /^[1-9]\d*$/;
const SUPPORTED_STATUSES = new Set<string>(["sent", "failed", "delivered", "read"]);

export type SupportedProviderStatus = "sent" | "failed" | "delivered" | "read";

export interface WhatsAppStatusItem {
  phoneNumberId: string;
  providerMessageId: string;
  recipientE164: string;
  status: SupportedProviderStatus;
  providerTimestamp: string;
}

export type StatusExtractionResult = { ok: true; items: WhatsAppStatusItem[] } | { ok: false };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

function hasOnlyEnumerableStringKeys(record: Record<string, unknown>): boolean {
  try {
    return !Reflect.ownKeys(record).some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(record, key));
  } catch {
    return false;
  }
}

function isCodePointLengthInRange(value: string, min: number, max: number): boolean {
  const length = [...value].length;
  return length >= min && length <= max;
}

/**
 * Extracts supported outbound status callbacks (`sent`/`delivered`/`read`/
 * `failed`) from a signed, envelope-validated WhatsApp webhook body. Status
 * names outside this four-value set are ignored so a future additive Meta
 * status does not make an otherwise-valid webhook retry forever. Returns
 * `{ ok: false }` if any supported status item is malformed — the caller
 * must reject the whole webhook and persist nothing in that case. Never
 * logs or mutates the input, and never returns raw errors, pricing, or
 * conversation metadata.
 */
export async function extractOutboundStatuses(body: { entry: unknown[] }): Promise<StatusExtractionResult> {
  const items: WhatsAppStatusItem[] = [];
  const seen = new Set<string>();

  try {
    for (const entry of body.entry) {
      const changes = asRecord(entry)?.changes;
      if (!Array.isArray(changes)) continue;

      for (const change of changes) {
        const changeObj = asRecord(change);
        if (changeObj?.field !== "messages") continue;

        const value = asRecord(changeObj.value);
        if (!value || !("statuses" in value)) continue;

        const statuses = value.statuses;
        if (!Array.isArray(statuses)) return { ok: false };

        const phoneNumberId = asRecord(value.metadata)?.phone_number_id;

        for (const rawStatus of statuses) {
          const looseStatus = asRecord(rawStatus);
          const statusValue = looseStatus?.status;
          if (typeof statusValue !== "string" || !SUPPORTED_STATUSES.has(statusValue)) continue;

          const statusObj = asPlainRecord(rawStatus);
          if (!statusObj || !hasOnlyEnumerableStringKeys(statusObj)) return { ok: false };

          if (typeof phoneNumberId !== "string" || !PHONE_NUMBER_ID_PATTERN.test(phoneNumberId)) return { ok: false };

          const { id, timestamp, recipient_id: recipientId } = statusObj;

          if (typeof id !== "string" || !isCodePointLengthInRange(id, 1, 512)) return { ok: false };
          if (typeof recipientId !== "string" || !RECIPIENT_PATTERN.test(recipientId)) return { ok: false };
          if (typeof timestamp !== "string" || !TIMESTAMP_PATTERN.test(timestamp)) return { ok: false };

          const timestampSeconds = Number(timestamp);
          if (!Number.isSafeInteger(timestampSeconds)) return { ok: false };
          const timestampDate = new Date(timestampSeconds * 1000);
          if (!Number.isFinite(timestampDate.getTime())) return { ok: false };

          const status = statusValue as SupportedProviderStatus;
          const recipientE164 = `+${recipientId}`;
          const providerTimestamp = timestampDate.toISOString();

          const dedupeKey = JSON.stringify([phoneNumberId, id, recipientE164, status, timestamp]);
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);

          items.push({ phoneNumberId, providerMessageId: id, recipientE164, status, providerTimestamp });
        }
      }
    }
  } catch {
    return { ok: false };
  }

  return { ok: true, items };
}
