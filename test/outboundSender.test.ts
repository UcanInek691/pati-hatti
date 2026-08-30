import { afterEach, describe, expect, it, vi } from "vitest";
import { drainOutboundMessages, MAX_OUTBOUND_ROWS_PER_RUN } from "../src/outboundSender";
import * as outboundDelivery from "../src/outboundDelivery";
import * as whatsappSend from "../src/whatsappSend";
import type { Env } from "../src/env";
import type { IntakeQueueMessage } from "../src/intakeQueue";

vi.mock("../src/outboundDelivery");
vi.mock("../src/whatsappSend");

const claimOutboundMessageV2 = vi.mocked(outboundDelivery.claimOutboundMessageV2);
const releaseOutboundMessage = vi.mocked(outboundDelivery.releaseOutboundMessage);
const acceptOutboundMessage = vi.mocked(outboundDelivery.acceptOutboundMessage);
const sendWhatsAppTextMessage = vi.mocked(whatsappSend.sendWhatsAppTextMessage);

const whatsappAccountId = "33333333-3333-3333-3333-333333333333";
const resolvedAccessToken = "resolved-access-token";

const env: Env = {
  APP_TIMEZONE: "Europe/Istanbul",
  WHATSAPP_VERIFY_TOKEN: "secret-token",
  WHATSAPP_APP_SECRET: "test-app-secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  SUPABASE_ANON_KEY: "test-anon-key",
  OPENAI_API_KEY: "unused",
  INTAKE_QUEUE: { send: async () => {} } as unknown as Queue<IntakeQueueMessage>,
  WHATSAPP_ACCOUNT_CREDENTIALS_JSON: JSON.stringify([
    { whatsapp_account_id: whatsappAccountId, phone_number_id: "918000001", access_token: resolvedAccessToken },
  ]),
  WHATSAPP_GRAPH_API_VERSION: "v25.0",
};

const claimedRow = {
  kind: "claimed" as const,
  outboxId: "11111111-1111-1111-1111-111111111111",
  claimToken: "22222222-2222-2222-2222-222222222222",
  whatsappAccountId,
  phoneNumberId: "918000001",
  recipientE164: "+15550011111",
  content: "Hello",
  attemptCount: 1,
};

// Same outboxId/claimToken/phoneNumberId as claimedRow, but an account id with
// no matching entry in env.WHATSAPP_ACCOUNT_CREDENTIALS_JSON above.
const claimedRowUnknownAccount = {
  ...claimedRow,
  whatsappAccountId: "44444444-4444-4444-4444-444444444444",
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("drainOutboundMessages", () => {
  it.each([
    ["an invalid credential registry", { ...env, WHATSAPP_ACCOUNT_CREDENTIALS_JSON: "" }],
    ["a malformed graph version", { ...env, WHATSAPP_GRAPH_API_VERSION: "25.0" }],
  ])("performs zero database or Meta calls for %s", async (_label, badEnv) => {
    await drainOutboundMessages(badEnv);
    expect(claimOutboundMessageV2).not.toHaveBeenCalled();
    expect(sendWhatsAppTextMessage).not.toHaveBeenCalled();
    expect(acceptOutboundMessage).not.toHaveBeenCalled();
    expect(releaseOutboundMessage).not.toHaveBeenCalled();
  });

  it("stops immediately on empty", async () => {
    claimOutboundMessageV2.mockResolvedValue({ kind: "empty" });
    await drainOutboundMessages(env);
    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppTextMessage).not.toHaveBeenCalled();
  });

  it("stops immediately on a claim transport failure", async () => {
    claimOutboundMessageV2.mockResolvedValue({ kind: "failed" });
    await drainOutboundMessages(env);
    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(1);
    expect(sendWhatsAppTextMessage).not.toHaveBeenCalled();
  });

  it("continues past an exhausted row without sending", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce({ kind: "exhausted" }).mockResolvedValueOnce({ kind: "empty" });
    await drainOutboundMessages(env);
    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
    expect(sendWhatsAppTextMessage).not.toHaveBeenCalled();
  });

  it("performs claim -> resolve credential -> Meta -> accept in order on success, then continues", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow).mockResolvedValueOnce({ kind: "empty" });
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "accepted", providerMessageId: "wamid.PROVIDER1" });
    acceptOutboundMessage.mockResolvedValue({ kind: "accepted" });

    await drainOutboundMessages(env);

    expect(sendWhatsAppTextMessage).toHaveBeenCalledWith(
      claimedRow.phoneNumberId,
      claimedRow.recipientE164,
      claimedRow.content,
      resolvedAccessToken,
      env,
    );
    expect(acceptOutboundMessage).toHaveBeenCalledWith(claimedRow.outboxId, claimedRow.claimToken, "wamid.PROVIDER1", env);
    expect(releaseOutboundMessage).not.toHaveBeenCalled();
    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
  });

  it("releases without ever calling Meta when the claimed account has no matching credential", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRowUnknownAccount).mockResolvedValueOnce({ kind: "empty" });
    releaseOutboundMessage.mockResolvedValue({ kind: "retry_scheduled" });

    await drainOutboundMessages(env);

    expect(sendWhatsAppTextMessage).not.toHaveBeenCalled();
    expect(acceptOutboundMessage).not.toHaveBeenCalled();
    expect(releaseOutboundMessage).toHaveBeenCalledWith(claimedRowUnknownAccount.outboxId, claimedRowUnknownAccount.claimToken, env);
    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
  });

  it.each(["retry_scheduled", "failed", "stale"] as const)(
    "continues after a %s release result for an unresolved credential",
    async (result) => {
      claimOutboundMessageV2.mockResolvedValueOnce(claimedRowUnknownAccount).mockResolvedValueOnce({ kind: "empty" });
      releaseOutboundMessage.mockResolvedValue({ kind: result });

      await drainOutboundMessages(env);

      expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
    },
  );

  it("stops the drain on release transport failure for an unresolved credential", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRowUnknownAccount);
    releaseOutboundMessage.mockResolvedValue({ kind: "call_failed" });

    await drainOutboundMessages(env);

    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(1);
  });

  it("continues after an already_accepted acceptance replay", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow).mockResolvedValueOnce({ kind: "empty" });
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "accepted", providerMessageId: "wamid.PROVIDER1" });
    acceptOutboundMessage.mockResolvedValue({ kind: "already_accepted" });

    await drainOutboundMessages(env);

    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
    expect(releaseOutboundMessage).not.toHaveBeenCalled();
  });

  it("continues after a stale acceptance result (safe to skip)", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow).mockResolvedValueOnce({ kind: "empty" });
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "accepted", providerMessageId: "wamid.PROVIDER1" });
    acceptOutboundMessage.mockResolvedValue({ kind: "stale" });

    await drainOutboundMessages(env);

    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
    expect(releaseOutboundMessage).not.toHaveBeenCalled();
  });

  it("stops the drain on acceptance transport failure without falsely succeeding", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow);
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "accepted", providerMessageId: "wamid.PROVIDER1" });
    acceptOutboundMessage.mockResolvedValue({ kind: "failed" });

    await drainOutboundMessages(env);

    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(1);
  });

  it("performs claim -> Meta failure -> release and never calls accept", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow).mockResolvedValueOnce({ kind: "empty" });
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "failed" });
    releaseOutboundMessage.mockResolvedValue({ kind: "retry_scheduled" });

    await drainOutboundMessages(env);

    expect(acceptOutboundMessage).not.toHaveBeenCalled();
    expect(releaseOutboundMessage).toHaveBeenCalledWith(claimedRow.outboxId, claimedRow.claimToken, env);
    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
  });

  it.each(["retry_scheduled", "failed", "stale"] as const)("continues after a release result of %s", async (result) => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow).mockResolvedValueOnce({ kind: "empty" });
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "failed" });
    releaseOutboundMessage.mockResolvedValue({ kind: result });

    await drainOutboundMessages(env);

    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(2);
  });

  it("stops the drain on release transport failure without falsely succeeding", async () => {
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow);
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "failed" });
    releaseOutboundMessage.mockResolvedValue({ kind: "call_failed" });

    await drainOutboundMessages(env);

    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(1);
  });

  it("processes at most ten rows even if more remain", async () => {
    claimOutboundMessageV2.mockResolvedValue({ kind: "exhausted" });

    await drainOutboundMessages(env);

    expect(claimOutboundMessageV2).toHaveBeenCalledTimes(MAX_OUTBOUND_ROWS_PER_RUN);
    expect(sendWhatsAppTextMessage).not.toHaveBeenCalled();
  });

  it("does not log identifiers, recipients, content, provider ids, or secrets", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    claimOutboundMessageV2.mockResolvedValueOnce(claimedRow).mockResolvedValueOnce({ kind: "empty" });
    sendWhatsAppTextMessage.mockResolvedValue({ kind: "accepted", providerMessageId: "wamid.PROVIDER1" });
    acceptOutboundMessage.mockResolvedValue({ kind: "accepted" });

    await drainOutboundMessages(env);

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
