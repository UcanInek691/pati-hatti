# Inbound intake queue (producer only)

Last verified: 2026-08-08.

## What this step does

After a signed inbound WhatsApp text message is durably persisted through the
`ingest_whatsapp_text_message` RPC (see `docs/database-schema.md`), the Worker
publishes one small versioned job to a Cloudflare Queue named `vetai-intake`
before it acknowledges the webhook with HTTP 200. The webhook response
`await`s the Queue send; it does not use `waitUntil` and does not return
early.

- Both `processed` and exact-`duplicate` persistence outcomes are enqueued.
  Enqueuing duplicates is deliberate: it repairs the case where the database
  write committed but the first Queue send or webhook HTTP response failed
  before the sender's retry, so the retry's duplicate outcome still gets a job
  published.
- `unknown_account` and `failed` persistence outcomes are never enqueued.
- If the required enqueue fails for any item, that item counts as `failed`
  and the webhook returns its existing HTTP 503 response, unchanged from
  Task 010. HTTP 200 is only returned after every processed/duplicate item's
  Queue send has resolved.

## Message contract

`src/intakeQueue.ts` exports a closed, versioned message shape with exactly
three fields:

```text
version: 1
conversationId: string
providerMessageId: string
```

It never includes message text, phone number, owner or pet name, clinic ID,
payload hash, extraction output, prompts, secrets, or any provider response
data. A future consumer re-fetches whatever context it needs from Supabase
using `conversationId` through the existing service-role-only, tenant-scoped
RPC; it does not rely on service-role RLS enforcement.

## Delivery semantics

Cloudflare Queues confirm a message is durably written to disk once
`Queue.send()` resolves, and delivery is at least once. Combined with
WhatsApp's own webhook retry behavior, the same job can be enqueued more than
once for the same message. This is expected and accepted at this stage: a
future consumer (Task 012) must validate the message again and behave
idempotently before any Queue consumer, deploy, or production use is
approved.

## Not implemented in this step

- No `queue()` consumer handler and no `[[queues.consumers]]` binding exist
  yet.
- No LLM call, safety evaluation, conversation-state advance, or outbound
  WhatsApp message happens from this step.
- No real Cloudflare Queue resource has been created, and nothing has been
  deployed.
- Production approval for the producer configuration is contingent on a
  reviewed consumer existing first.
