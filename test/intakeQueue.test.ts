import { describe, expect, it, vi } from "vitest";
import { enqueueIntakeJob, type IntakeQueueMessage } from "../src/intakeQueue";

const CONVERSATION_ID = "5c1f2b9e-9d6a-4c3b-8f21-6f7a2c1d3e4b";
const PROVIDER_MESSAGE_ID = "wamid.ID1";

function stubQueue(send: (message: unknown, options?: unknown) => Promise<void>): Queue<IntakeQueueMessage> {
  return { send } as unknown as Queue<IntakeQueueMessage>;
}

describe("enqueueIntakeJob", () => {
  it("sends exactly the three-field versioned JSON message with contentType json", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const result = await enqueueIntakeJob(stubQueue(send), CONVERSATION_ID, PROVIDER_MESSAGE_ID);

    expect(result).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      { version: 1, conversationId: CONVERSATION_ID, providerMessageId: PROVIDER_MESSAGE_ID },
      { contentType: "json" },
    );
  });

  it("fails closed without logging when the binding is missing", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");

    const result = await enqueueIntakeJob(undefined, CONVERSATION_ID, PROVIDER_MESSAGE_ID);

    expect(result).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails closed without logging when send rejects", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));

    const result = await enqueueIntakeJob(stubQueue(send), CONVERSATION_ID, PROVIDER_MESSAGE_ID);

    expect(result).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails closed without logging when send throws synchronously", async () => {
    const logSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error");
    const send = vi.fn(() => {
      throw new Error("queue unavailable");
    });

    const result = await enqueueIntakeJob(stubQueue(send), CONVERSATION_ID, PROVIDER_MESSAGE_ID);

    expect(result).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
