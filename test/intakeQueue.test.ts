import { describe, expect, it, vi } from "vitest";
import { enqueueIntakeJob, parseIntakeQueueMessage, type IntakeQueueMessage } from "../src/intakeQueue";

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

describe("parseIntakeQueueMessage", () => {
  const VALID = { version: 1, conversationId: CONVERSATION_ID, providerMessageId: PROVIDER_MESSAGE_ID };

  it("accepts a valid message and returns a fresh object", () => {
    const result = parseIntakeQueueMessage(VALID);
    expect(result).toEqual({ ok: true, message: VALID });
    if (result.ok) {
      expect(result.message).not.toBe(VALID);
    }
  });

  it("does not mutate the input object", () => {
    const input = { ...VALID };
    const frozen = Object.freeze({ ...input });
    parseIntakeQueueMessage(frozen);
    expect(frozen).toEqual(input);
  });

  it.each([null, undefined, "string", 42, true, ["array"], [1, 2, 3]])("rejects non-plain-object input: %j", (input) => {
    expect(parseIntakeQueueMessage(input)).toEqual({ ok: false });
  });

  it("rejects a class instance (exotic prototype)", () => {
    class Msg {
      version = 1;
      conversationId = CONVERSATION_ID;
      providerMessageId = PROVIDER_MESSAGE_ID;
    }
    expect(parseIntakeQueueMessage(new Msg())).toEqual({ ok: false });
  });

  it("rejects a null-prototype object", () => {
    const input = Object.assign(Object.create(null), VALID);
    expect(parseIntakeQueueMessage(input)).toEqual({ ok: false });
  });

  it("rejects a Proxy whose property access throws", () => {
    const proxy = new Proxy(
      { ...VALID },
      {
        get() {
          throw new Error("boom");
        },
      },
    );
    expect(parseIntakeQueueMessage(proxy)).toEqual({ ok: false });
  });

  it.each(["version", "conversationId", "providerMessageId"])("rejects a missing key: %s", (key) => {
    const input = { ...VALID } as Record<string, unknown>;
    delete input[key];
    expect(parseIntakeQueueMessage(input)).toEqual({ ok: false });
  });

  it("rejects an extra key", () => {
    expect(parseIntakeQueueMessage({ ...VALID, extra: "nope" })).toEqual({ ok: false });
  });

  it("rejects non-enumerable and symbol extra keys", () => {
    const nonEnumerable = { ...VALID };
    Object.defineProperty(nonEnumerable, "hidden", { value: "nope" });
    expect(parseIntakeQueueMessage(nonEnumerable)).toEqual({ ok: false });
    expect(parseIntakeQueueMessage({ ...VALID, [Symbol("extra")]: "nope" })).toEqual({ ok: false });
  });

  it.each([0, 2, "1", true, null, undefined])("rejects a non-literal-1 version: %j", (version) => {
    expect(parseIntakeQueueMessage({ ...VALID, version })).toEqual({ ok: false });
  });

  it.each([123, null, "", "not-a-uuid", "5c1f2b9e-9d6a-4c3b-8f21-6f7a2c1d3e4bXX", " 5c1f2b9e-9d6a-4c3b-8f21-6f7a2c1d3e4b"])(
    "rejects a malformed conversationId: %j",
    (conversationId) => {
      expect(parseIntakeQueueMessage({ ...VALID, conversationId })).toEqual({ ok: false });
    },
  );

  it.each([123, null, "", "   ", " leading", "trailing ", "both "])("rejects an invalid providerMessageId: %j", (providerMessageId) => {
    expect(parseIntakeQueueMessage({ ...VALID, providerMessageId })).toEqual({ ok: false });
  });

  it("accepts a providerMessageId of exactly 512 Unicode code points, including astral characters", () => {
    const providerMessageId = "\u{1F436}".repeat(512);
    const result = parseIntakeQueueMessage({ ...VALID, providerMessageId });
    expect(result).toEqual({ ok: true, message: { ...VALID, providerMessageId } });
  });

  it("rejects a providerMessageId of 513 Unicode code points, even if UTF-16 length is smaller than a 513-char ASCII string", () => {
    const providerMessageId = "\u{1F436}".repeat(513);
    expect(parseIntakeQueueMessage({ ...VALID, providerMessageId })).toEqual({ ok: false });
  });
});
