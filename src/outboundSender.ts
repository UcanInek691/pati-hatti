import type { Env } from "./env";
import { acceptOutboundMessage, claimOutboundMessageV2, releaseOutboundMessage } from "./outboundDelivery";
import { resolveWhatsAppAccessToken, isWhatsAppCredentialRegistryValid } from "./whatsappCredentials";
import { sendWhatsAppTextMessage } from "./whatsappSend";

export const MAX_OUTBOUND_ROWS_PER_RUN = 10;
// Database-owned bounds (see supabase/migrations/20260809000200_outbound_delivery.sql);
// documented here for operators reading this file, not enforced by this code.
export const MAX_OUTBOUND_DELIVERY_ATTEMPTS = 3;
export const OUTBOUND_DELIVERY_LEASE_MINUTES = 5;
export const OUTBOUND_RETRY_DELAY_MINUTES = 2;

const GRAPH_VERSION_PATTERN = /^v\d+\.0$/;

function hasValidMetaConfig(env: Env): boolean {
  return GRAPH_VERSION_PATTERN.test(env.WHATSAPP_GRAPH_API_VERSION) && isWhatsAppCredentialRegistryValid(env.WHATSAPP_ACCOUNT_CREDENTIALS_JSON);
}

/**
 * Drains at most `MAX_OUTBOUND_ROWS_PER_RUN` pending outbox rows: claim
 * through the tenant-safe V2 RPC, resolve that exact account's Meta
 * credential, send once through Meta, then accept or release exactly once
 * per row. A row whose claimed account has no matching registry entry is
 * released without ever calling Meta. At-least-once delivery only — a lost
 * acceptance response can produce a rare duplicate send on a later run.
 * Never throws; never logs identifiers, recipients, content, or secrets.
 */
export async function drainOutboundMessages(env: Env): Promise<void> {
  if (!hasValidMetaConfig(env)) return;

  for (let i = 0; i < MAX_OUTBOUND_ROWS_PER_RUN; i++) {
    const claim = await claimOutboundMessageV2(env);

    if (claim.kind === "empty" || claim.kind === "failed") return;
    if (claim.kind === "exhausted") continue;

    const credential = resolveWhatsAppAccessToken(env.WHATSAPP_ACCOUNT_CREDENTIALS_JSON, claim.whatsappAccountId, claim.phoneNumberId);
    if (credential.kind === "not_found") {
      const release = await releaseOutboundMessage(claim.outboxId, claim.claimToken, env);
      if (release.kind === "retry_scheduled" || release.kind === "failed" || release.kind === "stale") continue;
      return;
    }

    const send = await sendWhatsAppTextMessage(claim.phoneNumberId, claim.recipientE164, claim.content, credential.accessToken, env);

    if (send.kind === "accepted") {
      const accept = await acceptOutboundMessage(claim.outboxId, claim.claimToken, send.providerMessageId, env);
      if (accept.kind === "accepted" || accept.kind === "already_accepted" || accept.kind === "stale") continue;
      return;
    }

    const release = await releaseOutboundMessage(claim.outboxId, claim.claimToken, env);
    if (release.kind === "retry_scheduled" || release.kind === "failed" || release.kind === "stale") continue;
    return;
  }
}
