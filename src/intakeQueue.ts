export interface IntakeQueueMessage {
  version: 1;
  conversationId: string;
  providerMessageId: string;
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
    await queue.send({ version: 1, conversationId, providerMessageId }, { contentType: "json" });
  } catch {
    return false;
  }

  return true;
}
