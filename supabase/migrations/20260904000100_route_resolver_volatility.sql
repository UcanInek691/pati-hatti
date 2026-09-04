-- Task 049: persist the PostgREST route-resolver volatility invariant.
--
-- `20260814000300_selective_automation.sql` created
-- `public.resolve_whatsapp_contact_automation(text, text)` as `STABLE`.
-- `20260831000100_clinic_lifecycle.sql` later gave the helper it calls,
-- `vetai_private.effective_contact_automation_mode(uuid, text)`, a row lock
-- (`for key share of cl`). PostgREST runs a POST to a `STABLE`/`IMMUTABLE`
-- RPC in a read-only transaction, so the row lock was rejected and the
-- resolver returned HTTP 405 on every real inbound WhatsApp message from
-- 2026-08-31 03:13 to 2026-09-04 03:44 in `vetai-staging`. See
-- docs/olaylar/2026-09-04-route-resolver-405.md.
--
-- Staging was repaired manually with the exact statement below, but no
-- migration carried it, so a database built only from this repository would
-- still reproduce the outage. This is the smallest root-cause fix: change
-- only the volatility label of the exact existing function. Do not drop or
-- recreate the function and do not copy its body. Not run against any
-- database by the implementer.

alter function public.resolve_whatsapp_contact_automation(text, text) volatile;
