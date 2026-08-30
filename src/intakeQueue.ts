export interface IntakeQueueMessage {
  version: 1;
  conversationId: string;
  providerMessageId: string;
}

export type ParsedIntakeQueueMessage = { ok: true; message: IntakeQueueMessage } | { ok: false };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = ["version", "conversationId", "providerMessageId"] as const;

/**
 * Strictly revalidates an untrusted Cloudflare Queue message body. Accepts
 * only a plain object with exactly the three documented fields; rejects
 * everything else, including a Proxy whose property access throws. Never
 * mutates or logs the input; always returns a fresh object on success.
 */
export function parseIntakeQueueMessage(input: unknown): ParsedIntakeQueueMessage {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false };
    }
    if (Object.getPrototypeOf(input) !== Object.prototype) {
      return { ok: false };
    }

    const keys = Reflect.ownKeys(input);
    if (keys.length !== ALLOWED_KEYS.length || !ALLOWED_KEYS.every((key) => Object.prototype.hasOwnProperty.call(input, key))) {
      return { ok: false };
    }

    const { version, conversationId, providerMessageId } = input as Record<string, unknown>;

    if (version !== 1) {
      return { ok: false };
    }
    if (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId)) {
      return { ok: false };
    }
    if (typeof providerMessageId !== "string" || providerMessageId.length < 1) {
      return { ok: false };
    }
    if (providerMessageId.trim() !== providerMessageId) {
      return { ok: false };
    }
    if ([...providerMessageId].length > 512) {
      return { ok: false };
    }

    return { ok: true, message: { version: 1, conversationId, providerMessageId } };
  } catch {
    return { ok: false };
  }
}

/**
 * Publishes one versioned intake job for an already-persisted inbound
 * message. Resolves `true` only after the Queue confirms the send; fails
 * closed on a missing binding or a rejected send. Never logs the message or
 * identifiers.
 */
export async function enqueueIntakeJob(
  queue: Queue<IntakeQueueMessage> | undefined,
  conversationId: string,
  providerMessageId: string,
): Promise<boolean> {
  if (!queue) {
    return false;
  }

  try {
    await queue.send({ version: 1, conversationId, providerMessageId }, { contentType: "json", delaySeconds: 3 });
  } catch {
    return false;
  }

  return true;
}
