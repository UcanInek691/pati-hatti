-- Strict AI allowlist for every WhatsApp account.
-- Unlisted contacts inherit `personal`; only an exact `ai` route enters
-- automation. This is a forward-only hardening migration for Task 034.
-- Apply only through the repo's managed, file-atomic migration workflow;
-- do not run these statements individually in SQL Editor.

alter table public.whatsapp_accounts
  drop constraint whatsapp_accounts_automation_default_check;

alter table public.whatsapp_accounts
  alter column automation_default set default 'personal';

update public.whatsapp_accounts
set automation_default = 'personal'
where automation_default <> 'personal';

alter table public.whatsapp_accounts
  add constraint whatsapp_accounts_automation_default_check
  check (automation_default = 'personal');

-- Remove unsent work that is no longer explicitly authorized. Deleting a
-- processing row prevents lease-expiry reclaim/retry, but cannot recall the
-- single network request if a sender already handed it to Meta.
delete from public.outbound_message_outbox oo
where oo.delivery_status in ('pending', 'processing')
  and not exists (
    select 1
    from public.whatsapp_contact_routes r
    where r.whatsapp_account_id = oo.whatsapp_account_id
      and r.contact_e164 = oo.recipient_e164
      and r.mode = 'ai'
  );
