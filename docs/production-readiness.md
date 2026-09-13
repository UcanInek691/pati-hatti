# Production readiness runbook

Original checklist: 2026-08-10. Latest narrow reconciliation: Task 052,
2026-09-05; this is not a fresh verification of every historical checkbox.

This is an executable checklist, not production approval. Recorded staging
checks do not authorize a production target. The Task 024 baseline has since
been extended: `/ready` now checks the real PostgREST resolver boundary
(Task 050), and Tasks 051–052 record handoff recovery and latency evidence.
Completing a numbered code task does not complete the human, operational or
production-target gates below.

## 1. Human gates

- [ ] A named person or role owns clinic operations for this deployment
      (day-to-day monitoring, staff-item follow-up, incident response). Write
      their name/role and contact path here before go-live.
- [ ] A veterinarian at the operating clinic has read and approved every
      Turkish safety-check and appointment-flow message string the Worker can
      send using the Turkish
      [`veteriner-hekim-onay-paketi.md`](veteriner-hekim-onay-paketi.md).
      Approval must be recorded (who, date, which copy revision) before any
      real send.
- [ ] Turkish legal/KVKK (Kişisel Verilerin Korunması Kanunu) review and
      approval using the Turkish
      [`kvkk-inceleme-paketi.md`](kvkk-inceleme-paketi.md), covering at minimum:
  - the data-subject notice text and how/when it is shown,
  - the lawful basis relied on for processing pet-owner and pet-health data,
  - which roles (clinic staff, clinic owner, platform operator) may access
    what data,
  - retention periods for messages, intake data, and staff work items —
    **this document does not set or suggest a retention period; that is a
    legal decision**,
  - retention of the clinic AI-usage reconciliation report (Task 042,
    [`usage-metering.md`](usage-metering.md)) exported before an offboarding —
    the ledger itself has no independent retention and is deleted with the
    clinic, so this is only about the exported report; **this document does
    not set that period either**,
  - the deletion/export process for a data subject's request,
  - processor agreements with Cloudflare, Meta, OpenAI, and Supabase's
    hosting provider.
  - This step cannot be satisfied by an engineer's judgment call; it requires
    sign-off from whoever is accountable for KVKK compliance for the clinic.
  - **Open questions raised by Task 035 and carried here on 2026-08-26.** Task
    035 (pet onboarding) shipped `COMPLETE` with these deliberately unanswered;
    they were moved out of that task rather than closed inside it, because they
    are legal decisions and no engineering work can settle them. They are
    listed here so the `COMPLETE` stamp on Task 035 cannot be read as covering
    them:
    - **Is the pet-confirmation prompt itself an adequate disclosure moment?**
      The bot asks the owner to confirm a pet name and species before writing
      a `public.pets` row. Whether that prompt discharges any notice duty, or
      whether a separate notice must precede it, is unanswered.
    - **Do pet records need provenance for export?** `public.pets` has no
      column recording whether a row was created by the AI path or by clinic
      staff. Whether a data-subject export or deletion response must
      distinguish the two is unanswered. Adding such a column is also the
      prerequisite for the partial unique index named in
      `20260825000100_pet_registration.sql`, so a legal answer here has a
      direct engineering consequence.
    - **What notice, if any, must open a conversation, and in what words?**
      Raised by Maya on 2026-08-26 (see the Task 036 candidate in
      `CURRENT_TASK.md`): she wants a one-line notice at the start of a
      conversation saying messages are recorded for safety/legal reasons. The
      wording is a legal artifact, not a copy decision, and must not be
      finalized by an engineer or by the AI. It is the same
      notice-timing question as the first bullet, now with a concrete
      placement proposal attached.
  - `docs/kvkk-inceleme-paketi.md` is the technical package prepared for the
    reviewing expert; it states verified facts only and deliberately answers
    none of the above.

- [x] Multi-factor authentication is verified end-to-end, in staging, for
      every account enrolled in `platform_admins` before `/admin` (Task 043,
      [`platform-admin-overview.md`](platform-admin-overview.md)) is used
      against real data. Task 045 added a database-enforced TOTP `aal2`
      requirement (`get_platform_admin_overview_v1` now rejects any caller
      whose JWT `aal` claim is not exactly `aal2`, independent of
      `platform_admins` membership) and the corresponding `/admin` TOTP
      enrollment/challenge UI. The migration and rollback fixture passed on
      disposable `vetai-test`; the migration and Worker were subsequently
      activated only on `vetai-staging`. On 2026-09-02 one real staging account
      completed memory-only password recovery, exact-one interrupted TOTP
      cleanup, fresh text-key enrollment, TOTP verification, the membership
      rejection, and the allowlisted read-only overview. Production remains
      unchanged. The staging evidence in `docs/staging-runbook.md` confirmed,
      against a real Supabase project, that the migration applies cleanly after
      the Task 043 one, a password-only session cannot read overview data,
      a fresh account is forced through TOTP enrollment before it can, an
      already-enrolled account is forced through a challenge on every new
      session, and `platform_admins` membership without a verified TOTP
      factor (and vice versa) is still rejected. An interrupted first
      enrollment was also proven to remove only its
      single unverified TOTP factor and restart with one fresh enrollment
      (safe QR or the mandatory validated text key) while every
      verified, multiple, non-TOTP, or malformed factor state remains closed.
      The Supabase Auth MFA-verify rate limit was inspected and its actual
      configured value recorded in the staging evidence; the browser does not
      claim to provide its own brute-force boundary.
      On 2026-09-02 the obsolete invalid-email tester's platform-admin
      membership was disabled, leaving `1 / 1` allowlisted accounts with a
      verified factor. A fresh password login required a new six-digit TOTP
      challenge before the overview, and the project Auth setting showed a
      token-verification limit of 30 requests per five minutes per IP.

- [ ] The Task 049 route-resolver volatility fix
      (`supabase/migrations/20260904000100_route_resolver_volatility.sql`,
      [`olaylar/2026-09-04-route-resolver-405.md`](olaylar/2026-09-04-route-resolver-405.md))
      is applied to the target database, its `pg_proc`/grant/result catalog
      fixture (`supabase/tests/049_route_resolver_volatility.sql`) passes on a
      disposable database, the target database passes the equivalent
      read-only catalog checks, and a real service-role PostgREST POST to
      `resolve_whatsapp_contact_automation` and a live inbound WhatsApp smoke
      both succeed against that database. A SQL Editor call succeeding is not
      sufficient evidence: PostgREST's own read-only-transaction routing is
      what previously failed.
      Staging completed this full gate on 2026-09-04; the checkbox remains
      open for the production target and does not transfer staging evidence.
- [ ] Task 050 (`/ready` dependency-aware readiness; see
      [`olaylar/2026-09-04-route-resolver-405.md`](olaylar/2026-09-04-route-resolver-405.md))
      is **implemented, locally verified, Codex/Opus-reviewed and staging-
      activated**. It distinguishes two different things: `/health` remains the
      cheap process-liveness check with no external dependency, while `/ready`
      additionally probes the real Supabase/PostgREST route-resolver boundary
      (`resolve_whatsapp_contact_automation`) using one already-validated
      registry `phone_number_id` and a fixed synthetic sentinel contact — the
      exact boundary whose HTTP 405 failure mode caused the Task 049 staging
      incident. A `/ready` `200` is evidence that this one resolver call path
      is reachable and returns a configured mode (`ai`/`manual`/`personal`); it
      is not evidence that Meta, OpenAI, or a live WhatsApp round trip
      succeeds, and it does not replace the mandatory live inbound/reply smoke
      after an activation. Workers invocation logging must retain full pilot
      sampling with `redact_query_string = true`; Meta's query-carried webhook
      verification token/challenge must never be retained in log URLs. This
      checkbox stays unchecked until staging
      activation (`docs/staging-runbook.md`) and this production gate both
      complete.
- [ ] Task 051 (`resolve_staff_work_item` safe terminal-handoff recovery; see
      `docs/database-schema.md` and `docs/staff-workflow.md`) must be locally
      verified, Codex/Opus-reviewed and staging-activated. Its
      migration (`supabase/migrations/20260904000200_handoff_conversation_recovery.sql`)
      and rollback-only fixture
      (`supabase/tests/051_handoff_conversation_recovery.sql`) were not run by
      the implementer. Codex applied them only to disposable `vetai-test` on
      2026-09-05 by direct SQL query; the fixture passed with 13 zero residue
      counters and an independent residue query returned zero. Claude Opus's
      mandatory read-only review of lock ordering, tenant isolation and the
      historical-repair backfill returned PASS on 2026-09-05. Under separate
      owner approval, the staging migration/catalog/deploy, bounded synthetic
      `/staff` recovery with zero residue, and final allowlisted live handoff →
      resolve → fresh safety-screening smoke all passed on the same date.
      Production remains unchanged. The checkbox is reserved for the
      production target; recorded staging acceptance is retained above.

Task 052's read-only latency investigation found no new post-persistence
runtime blocker in the matched staging samples. Three historically delayed
replies took 18–23 seconds from DB receipt to Meta acceptance; the 61–74-minute
gap preceded successful persistence. Exact earlier retry attribution remains
INCONCLUSIVE. See [`the sanitized report`](olaylar/2026-09-05-delivery-latency.md).
This permits continued supervised allowlisted staging testing, not unattended
real-clinic operation or an SLA claim. No production box was closed by this
investigation; staff-send rate-limit verification and the existing operational
gates remain outstanding.

- [ ] Task 061's homepage `#network` section ships three static placeholder
      profile cards ("Örnek Klinik A/B/C"), each labeled "Staging örneği" /
      "Yer tutucu profil" with copy stating they represent no real vet,
      clinic, or partnership. Before any real clinic identity, name, photo,
      or credential is used in this section, a named person must confirm
      that clinic's real-world veterinary licensure/registration and their
      consent to be listed publicly.
- [ ] Record the source/provenance of Task 061's ImageGen-produced fixed garden
      and transparent mascot pose sheet, including the owner-approved clean scene
      frames used as references, and confirm commercial usage before any staging/
      production publication. If permission is insufficient, replace both assets
      with one coherent licensed/commissioned set and rerun responsive,
      accessibility, motion, CSP and transfer-budget checks.

No later section may be executed against real clinic/owner/pet data until
every box in this section is checked.

## 2. Managed data rollout

- [ ] A named person owns database backup and rollback for this rollout.
- [ ] Every migration under `supabase/migrations/`, in chronological
      filename order, is applied to the real production Supabase project
      through the managed Supabase CLI migration-history workflow (`supabase
      db push` or equivalent) — **not** by pasting SQL into the SQL Editor.
      Every migration through this task has so far only been validated on
      the disposable `vetai-test` project; see each migration's own
      `docs/*.md` note.
- [ ] After applying, verify the production catalog matches source: table
      list, RLS enabled per table, policy list, and function/table grants
      match what the migrations declare (spot-check with the same
      `pg_catalog`/`information_schema` queries the rollback test fixtures
      already use, run read-only).
- [ ] Rollback fixtures under `supabase/tests/*.sql` are **never** run
      against production. They exist only for disposable `vetai-test`
      validation; every one of them ends in `rollback;` by design and several
      assert on data that must not exist in production.

## 3. Cloudflare / Meta / OpenAI setup

- [ ] Create all three real Cloudflare Queue resources: `vetai-intake`,
      `vetai-intake-dlq`, and `vetai-intake-terminal-dlq`. Configure consumers
      only for the first two; the terminal queue is intentionally unconsumed
      (see §5 and §6).
- [ ] Deploy the Worker with both `[[queues.consumers]]` blocks in
      `wrangler.toml` (primary `vetai-intake` and the new `vetai-intake-dlq`
      consumer added in this task), and the `INTAKE_QUEUE` producer binding.
- [ ] Set every real secret (`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
      `WHATSAPP_ACCOUNT_CREDENTIALS_JSON`, `SUPABASE_SERVICE_ROLE_KEY`,
      `SUPABASE_ANON_KEY`, `OPENAI_API_KEY`) via `wrangler secret put`
      (encrypted secret bindings), never as a `[vars]` entry. **Never paste a
      real secret value into this document, a commit, an issue, or shell
      history** — use the interactive prompt or a piped value from a local,
      untracked file.
- [ ] Task 040 credential-isolation rollout uses this exact expand-first
      order: apply `claim_outbound_message_v2`, upload the complete encrypted
      registry, verify generic `/ready` on an unpublished/canary version,
      deploy the new Worker, then run one synthetic outbound/status smoke per
      configured account. Keep the legacy global token only for a named,
      bounded rollback window. Rollback is Worker-first to Task 039, using the
      preserved V1 RPC and legacy secret; V2 stays in place. Delete or rotate
      the legacy token only after every account smoke passes and the rollback
      window closes.
- [ ] Configure the Cron trigger (see `[triggers]` in `wrangler.toml`) and the
      Meta webhook subscription URL/verify token to point at the deployed
      Worker.
- [ ] Allow-list only the exact Meta Graph API version
      (`WHATSAPP_GRAPH_API_VERSION`, currently validated against `v<major>.0`
      by `/ready`) and OpenAI model the code actually calls
      (`src/openaiIntake.ts`); do not widen either without a corresponding
      code review.
- [ ] Confirm, on the Meta side (not just this repository), that the legacy
      `WHATSAPP_ACCESS_TOKEN` value pasted into chat before its removal has
      actually been revoked/rotated in Meta's system. The Cloudflare
      `WHATSAPP_ACCESS_TOKEN` secret is already deleted and unused (Task 040's
      per-account credential registry replaced it), but that only proves this
      repository stopped using the value — it does not prove Meta invalidated
      it. This checkbox stays unchecked, and production go-live is blocked,
      until someone with Meta App access confirms revocation and records how.



## 4. Seed / admin prerequisites

- [ ] Create the real clinic row, its WhatsApp account mapping
      (`phone_number_id`), and clinic staff membership rows through an
      authorized administrative process against production. The five
      service-role-only RPCs from Task 041
      (`provision_clinic_v1`/`suspend_clinic_v1`/`resume_clinic_v1`/
      `prepare_clinic_offboarding_v1`/`finalize_clinic_offboarding_v1`) remain
      the only mechanism for offboarding and for any production write not
      covered below — see [`docs/clinic-lifecycle.md`](clinic-lifecycle.md)
      for the exact pilot activation and offboarding order. As of Task 047,
      `/admin` additionally offers a bounded, MFA-gated self-serve path for
      **provision (always suspended), suspend, and resume only** — see
      [`docs/platform-admin-overview.md`](platform-admin-overview.md#klinik-yaşam-döngüsü-kontrolleri-görev-047).
      This does **not** replace the manual process: `/admin` never creates an
      Auth user, invites staff, writes a Meta credential (`phone_number_id`
      is metadata only — no access token/app secret/webhook secret/WABA token
      field exists), verifies external setup, offboards a clinic, or exposes
      customer content. A clinic provisioned from `/admin` is not usable
      until its WhatsApp credentials, Cloudflare secrets, and `/ready`/Meta
      webhook checks below are completed and it is explicitly resumed. Task
      047's migration and corrected rollback fixture passed on disposable
      `vetai-test` with zero fixture residue. The mandatory Opus review then
      passed and, on 2026-09-02/03, the migration, catalog boundary, Worker and
      bounded provision/suspend/resume behavior were verified on
      `vetai-staging`; migration history is aligned through Tasks 044, 045 and
      047 (`docs/staging-runbook.md` §17.1). This verifies the lifecycle-control
      surface, not a real new-clinic onboarding: external Meta/Cloudflare
      credentials, webhook/readiness checks and an explicit post-check resume
      remain required for every real clinic. The synthetic clinic remains
      suspended, the self-serve path is not approved for production, and
      production remains unchanged.
- [ ] Seed at least one future appointment slot before the smoke journey in
      §5 needs an `EVET`/`HAYIR` appointment decision. Since Task 044, this no
      longer requires a manual service-role write: the clinic's own `admin`
      staff can set that weekday's hours and generate the day's slots
      self-service from `/staff` (see
      [`docs/clinic-operations.md`](clinic-operations.md#task-044-self-service-hours-closures-and-slot-inventory-staff)),
      as long as staff membership rows already exist from the process above.
- [ ] Task 048's staff reply composer
      (`queue_staff_reply_v1`, see
      [`docs/staff-workflow.md`](staff-workflow.md#staff-reply-composer-task-048))
      is **implemented, locally verified and proven only on disposable
      `vetai-test`** — not staging-verified, not committed, and still pending
      the narrow closeout re-check after the first mandatory Opus review's
      corrections. Before it
      is considered for production go-live, the staging smoke journey in
      `docs/staging-runbook.md` must additionally prove: one real
      staff-queued WhatsApp reply accepted end-to-end with a status callback,
      an expired-service-window rejection, a cross-tenant/wrong-assignee/
      wrong-work-item-kind rejection, that queuing a reply does not itself
      resolve the work item or start a new automation turn, and that a
      contact route change does not delete an already-queued staff reply.
      `/staff` currently uses password-authenticated clinic membership and is
      not protected by Task 045's `/admin`-only TOTP/`aal2` flow; the required
      staff MFA/access policy must be explicitly decided and implemented (or
      formally accepted by security/legal owners) before production access.
      The staff-reply RPC currently has no conversation debounce, per-user
      rate limit, or daily clinic cap; define and verify an operational limit
      before broad production rollout so repeated clicks or compromised staff
      credentials cannot damage Meta quality or create uncontrolled sends.

## 5. Controlled smoke journey

Before any step below runs against production, the isolated staging
environment in [`staging-runbook.md`](staging-runbook.md) must have already
passed end to end with synthetic data, including its own Coexistence
evidence. Staging failures or an `UNAVAILABLE` Coexistence result block this
section.

Perform steps 1–8 against production with synthetic, non-patient data only
(a test phone number and a fabricated pet/complaint) — never a real owner's
data. Steps 9–10 are failure injection and must run only in an isolated
pre-production/canary Worker, Queue chain, and disposable database configured
like production. Never break a shared production secret or endpoint to force
a retry. Stop and fix before continuing if any step's actual result differs
from its expected result.

1. `GET /health` returns `200 { "status": "ok" }`.
2. `GET /ready` returns `200 { "status": "ready" }`. Since Task 050 this also
   proves the real Supabase/PostgREST route-resolver boundary
   (`resolve_whatsapp_contact_automation`) is reachable, not only local
   configuration shape — it is still not proof of a live Meta/OpenAI/WhatsApp
   round trip. If it returns `503`, stop — configuration or the route
   resolver is unavailable; do not proceed. While `OPERATIONAL_ALERTS_ENABLED`
   is unset the body stays byte-identical to this (Task 053); once activated
   it gains `"alertMonitorHeartbeat": "fresh" | "stale"` and a stale value
   also returns `503` — see `docs/operational-alerting.md` §6 for the
   activation proof this still requires.
3. The Meta webhook challenge (`GET /webhooks/whatsapp`) succeeds with the
   real verify token.
4. Send one signed synthetic inbound WhatsApp text message; confirm it is
   persisted (`docs/database-schema.md`) and a job reaches `vetai-intake`.
   Also send one recognizable group-message fixture and confirm the signed
   webhook returns 200 while creating no route-RPC call, database row, Queue
   job, OpenAI call, or reply. Do not use or expose a real group's content.
5. Confirm the Queue message is claimed, sent to OpenAI, and the
   conversation state advances (`docs/inbound-queue.md`).
6. Trigger a safety/human-handoff path with synthetic wording and confirm
   the conversation reaches `human_handoff` and a `staff_work_items` row
   appears for the clinic (`/staff`), with the correct priority.
7. Confirm an outbox row is sent and its delivery status callback is
   recorded (`docs/outbound-delivery.md`).
8. Walk one synthetic appointment through offer -> `EVET` confirm and,
   separately, offer -> `HAYIR` decline
   ([`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md)).
9. As the clinic's own `admin` staff on `/staff`, set one weekday's hours,
   generate that day's slots, add and then remove a closure date, and delete
   one still-`available` generated slot; confirm a non-`admin` staff member
   sees the same data read-only and that no held/confirmed slot from step 8
   is ever affected
   ([`docs/clinic-operations.md`](clinic-operations.md#task-044-self-service-hours-closures-and-slot-inventory-staff)).
10. In the isolated canary only, **deliberately exhaust the primary consumer's
   retries** for one synthetic message using a canary-only invalid Supabase
   binding or another reproducible failure that cannot affect production
   traffic. Confirm Cloudflare routes it to `vetai-intake-dlq`, the
   dead-letter consumer picks it up, and the conversation reaches
   `human_handoff` (or the appropriate closed result) via
   `finalize_intake_dead_letter`.
11. Confirm that recovery step happens **before** the retention window on an
    unconsumed queue elapses — see §6's DLQ monitoring requirement. Cloudflare
    documents that a queue without an active consumer, or a dead-letter queue
    configured on the DLQ itself (`vetai-intake-terminal-dlq` here), retains
    messages for `message_retention_period` (default 4 days/345,600s when
    unconfigured, configurable up to 14 days/1,209,600s); see
    [Cloudflare's dead-letter queues documentation](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
    Codex's 2026-09-05 Phase A review of Task 053 found that default/ceiling
    applies to plans where retention is configurable; Cloudflare's Queues
    pricing page separately documents that the **Workers Free plan carries a
    fixed 24-hour retention**, and this Worker's actual Workers plan tier and
    each queue's effective retention are **not verified** in this codebase.
    Until verified, treat the recovery deadline as **24 hours, not four days**;
    `vetai-intake-terminal-dlq` is temporary recovery storage for that window,
    not an audit archive — nothing in this codebase reads from it. See
    [`docs/operational-alerting.md`](operational-alerting.md#3-bağımsızlık) §3
    for the exact sources, dates checked, and the conservative-default
    rationale.

## 6. Operations

Faz A aktivasyon planı: [`docs/operational-alerting.md`](operational-alerting.md)
(Task 053, 2026-09-05). Bu bir kod/altyapı teslimi değildir — aşağıdaki
kutuların hiçbiri bu planla karşılanmış sayılmaz; yalnız Codex incelemesi ve
ayrı sahip onayıyla yürütülen gerçek Faz B aktivasyonundan sonra işaretlenir.

Task 054 Faz A (2026-09-06), yanıt durum alanı bulunan webhook 401/5xx
ölçümünün gerçek staging hesabında sanitize edilmiş aggregate biçimini
doğruladı ve fail-closed sorgu yolunu depoda uyguladı. Yakalanmamış Worker
exception'ının aynı durum alanını taşıdığı doğrulanmadı; o dal ayrı Faz B
kanıtı veya ayrı Worker-exception alarmı gerektirir. Sonraki bayrak-kapalı Faz
B paketinde monitoring token secret'ı kuruldu ve staging Worker deploy edildi;
ancak Cron heartbeat, e-posta teslimi veya aşağıdaki aktivasyon kutularından
herhangi biri için henüz kanıt yoktur. Hepsi işaretsiz kalır.

2026-09-07 Faz B ön kontrolü, açık `workers_trace_events` veri-kümesi
seçiminin gerçek kayıtlar varken geçerli bir boş aggregate ürettiğini buldu.
Run-a-query sözleşmesindeki tüm kullanılabilir veri kümelerini seçen boş
listeyle iki güvenli `401` tanığı doğru sayıldı; yanıttaki query yankısının da
bu boş listeyi koruduğu doğrulandı ve ayrıştırıcı eksik/dolu/değişmiş yankıyı
reddedecek biçimde kapatıldı. Depo düzeltildi fakat henüz yeniden incelenip
staging'e deploy edilmedi.
Dolayısıyla alarm etkinleştirme kapısı ve aşağıdaki kutular açık kalır.

Opus kapanışından sonra doğrulanmış düzeltme, gerçek hesap kimliği yalnız
staging Worker secret'ında olacak biçimde ve alarm bayrağı `false` kalırken
staging'e deploy edildi. Sağlık/panel smoke'ları 200, imzasız webhook reddi 401
döndü. Bu kanıt yalnız replacement deploy'un regresyonsuz olduğunu gösterir;
alıcı, VetAI/Resend e-postası, heartbeat ve aşağıdaki aktivasyon kutularından
hiçbirini kapatmaz.

Bağımsız readiness'in yapılandırma kapısı 2026-09-07'de kısmen kapandı:
Cloudflare Free planda Standalone Health Checks bulunmadığı için Better Stack
Free üzerinde staging `/ready` adresini üç dakikada bir kontrol eden monitör
oluşturuldu. İlk dış kontrol `Up` oldu; sağlayıcının kendi test e-postası
sahibine ulaştı. Gerçek failure/timeout, olay, kurtarma ve rollback tanıkları
çalıştırılmadığından aşağıdaki birleşik alarm kutusu işaretsiz kalır.

Aynı gün ayrı sahip onayıyla Resend test göndericisi ve yalnız sahibin adresi
kullanılarak sınırlı staging smoke'u yapıldı. Bir denetimli platform alıcısı ve
bir aktif test-kliniği alıcısı üzerinden oluşan dört genel alarm teslimatının
dördü de `accepted` oldu; bekleyen/claim edilmiş/başarısız teslimat kalmadı,
heartbeat ilerledi ve sahip dört e-postayı gördü. Bayrak hemen tekrar `false`
yapıldı ve `/ready` 200 doğrulandı. Özel gönderim alan adı, gerçek klinik
alıcıları, diğer hata/retry/recovery/yanlış-kiracı tanıkları ve production
hâlâ açık olduğundan aşağıdaki birleşik kutular işaretsiz kalır.

Bağımsız readiness yolu ayrıca kontrollü olarak gerçek 503'e düşürüldü:
`/health` ve `/staff` 200 kalırken Better Stack kesinti olayı açtı ve sahibine
bildirim gönderdi. Geçerli config + kapalı bayrak geri yüklendiğinde üç uç 200
oldu, monitör `Up` durumuna döndü ve recovery e-postası ulaştı. Bu yalnız
readiness failure/recovery kolunu kapatır; aşağıdaki birleşik webhook/exception
ve diğer alarm maddeleri tamamlanmadığı için kutular işaretsiz kalır.

- [ ] Alert on Worker exceptions **and actual webhook HTTP 5xx responses**,
      plus dependency-aware `/ready` failures. Task 052 observed HTTP 503
      with invocation `outcome=ok`; exception/outcome counters alone missed
      this failure class. Monitoring needs an owner and a verified notification
      path, not just an enabled log dashboard. `/ready` is cached for up to
      30 seconds per isolate and is not a Meta/OpenAI end-to-end probe. A
      Task 055 (2026-09-07), yakalanmamış exception'ı yanıt durumundan bağımsız
      `$workers.outcome` alanıyla sayan ayrı bir sorgu yolu ekledi. Task 057
      (2026-09-08) bu şekli gerçek Cloudflare hesabında, staging deploy'unda ve
      sınırlı bir flag-on penceresinde doğruladı; heartbeat tazelendi ve bir
      platform alarm e-postası kabul edildi. Bu kutu yine açık kalır: pencere
      sonunda bayrak kapatıldı ve sürekli production alarm sahipliği ile tüm
      gerçek exception/HTTP-5xx dalları kanıtlanmadı. See
      [`docs/operational-alerting.md`](operational-alerting.md#10-task-055--worker_exception-sinyali-2026-09-07-aktivasyon-yok)
      §10 for the local implementation evidence and
      [`docs/operational-alerting.md`](operational-alerting.md#2-en-küçük-desteklenen-yol)
      §2 for the two smallest supported fallback options and the open Phase B
      remaining production/owner gates.
- [ ] Alert on backlog depth for all three queues: `vetai-intake`,
      `vetai-intake-dlq`, and `vetai-intake-terminal-dlq`. A non-zero
      `vetai-intake-terminal-dlq` backlog is the last-resort signal that a
      message is about to age out of its retention window (conservatively
      24 hours until the account's Workers plan/effective retention is
      verified — see §5 step 11) and needs manual recovery.
- [ ] Alert on failed outbox sends (`docs/outbound-delivery.md`).
- [ ] Alert on, or at minimum regularly review, open/urgent
      `staff_work_items` rows per clinic — **a staff work item being created
      is not the same as anyone being notified**; someone must actually watch
      `/staff` or a query against `staff_work_items` for this to have any
      effect. Urgent items must notify immediately on first observation, not
      after a delay. A normal-priority item created from the
      `{ "dead_letter_handoff": true }` marker represents **unassessed** risk,
      not low risk, and must be routed to its own immediate notification path
      separate from the ordinary normal-priority digest — without being
      clinically labeled "urgent" — and reviewed promptly; see
      [`docs/operational-alerting.md`](operational-alerting.md#1-sinyal-eylem-matrisi)
      §1 rows 7-9.
- [ ] Alert on webhook signature-verification failures and repeated Meta
      webhook delivery failures.
- [ ] Alert on repeated OpenAI extraction failures.
- [ ] Document who owns responding to each alert above and their expected
      response time before go-live.
- [ ] Note (Task 056, 2026-09-07): clinic alert mail now has three
      independent tiers — a staff member's own subscription, a platform-admin
      clinic-wide rollout gate, and the global Worker alert activation above.
      This clarifies *who* within an already-notified clinic receives mail;
      it does not close any unchecked box above. Its direct-query migration,
      rollback fixture and catalog/grant/zero-residue proof first passed on
      disposable `vetai-test`; Task 057 then applied it to staging and proved
      both browser controls. A bounded window proved platform mail and the
      live WhatsApp path, but clinic mail remained `BLOCKED` by the Resend test
      sender/recipient boundary. The window ended with global and clinic gates
      off; production was not changed. This still does not close the unchecked
      production/owner/KVKK/veterinary boxes above. See
      [`docs/operational-alerting.md`](operational-alerting.md#11-task-056--klinik-e-posta-uyarı-tercihleri-üç-bağımsız-katman-2026-09-07-aktivasyon-yok)
      §11–12 and [`docs/staging-runbook.md`](staging-runbook.md) §29.

## 7. Go / no-go and rollback

**No-go** if any of the following is true at deploy time:

- Any §1 human gate is unchecked.
- A secret value has leaked into a commit, log, or this document.
- A tenant-isolation (RLS or tenant-scoped join) failure is found in
  production verification.
- DLQ/terminal-queue backlog monitoring (§6) is not wired up.
- Clinic/veterinarian copy or KVKK privacy approval is missing or stale
  relative to the deployed copy.
- The webhook-triggered Worker path cannot be disabled quickly and safely
  (e.g., by pausing the Cloudflare route or webhook subscription) if
  something goes wrong during the smoke journey.

**Rollback order** (no destructive command is included here; each step is an
operational action, not a code snippet):

1. Disable the Meta webhook subscription or pause the Worker's route so no
   new inbound messages are accepted.
2. Let in-flight Queue batches drain or fail closed to their DLQ/terminal
   queue naturally — do not purge a queue.
3. If a migration must be reverted, write and review a forward-only
   corrective migration rather than editing history; coordinate with the
   backup/rollback owner from §2 before touching production data.
4. Re-run the §5 smoke journey after any fix, before re-enabling the
   webhook.

Passing Task 024's own review gate (Codex validation on disposable
`vetai-test`, then one narrow Opus review of the new database finalizer,
tenant isolation, staff visibility, and fail-closed Queue behavior) completes
the code-level MVP. It does **not** check any box in this document.

## 8. Custom-domain activation checklist

Written in Task 058 as documentation only. Task 059 then executed the
**staging** half of it on the owner's own domain `patihatti.com`; the
**production** half below remains `NOT RUN`. The per-step split is in §8.1 —
read it before treating any item here as done.

This is the single source for moving the production Worker off `workers.dev`
onto the owner's own hostname; it is referenced, not repeated, from
[`docs/staging-runbook.md`](staging-runbook.md). Every item below is
`NOT RUN` — writing this checklist and reorganizing `/staff` and `/admin`
into a shared native shell proves neither domain ownership nor production
activation.

1. **Hostname.** Owner supplies and confirms the exact production
   application hostname. Recommended topology: one application origin, e.g.
   `app.<owner-domain>/staff` and `app.<owner-domain>/admin`. Marketing
   content, if any, stays outside this Worker and outside Task 058.
2. **Cloudflare binding.** Bind that hostname to the production Worker via a
   Cloudflare Workers custom domain/route only after confirming the zone and
   Worker target. Keep the `workers.dev` staging hostname separate from
   production.
3. **Supabase Auth.** Update the Auth Site URL and exact redirect
   allow-list entries for the chosen production staff/admin and recovery
   flows. No unrestricted production wildcard. Verify password recovery and
   MFA sign-in from the new custom origin before relying on it.
4. **Edge checks.** Re-check CSP, CORS/origin assumptions, `/health`,
   `/ready`, `/staff/config.json` and `/admin/config.json` on the new
   origin. Update the Better Stack production monitor only after the new
   endpoint is confirmed healthy.
5. **E-mail subdomain.** Configure a separately authenticated e-mail sending
   subdomain in Resend before enabling real clinic e-mail. It need not equal
   the application hostname.
6. **Smoke + evidence.** Run desktop/mobile staff/admin smoke, one
   allowlisted WhatsApp canary, and the bounded alert proof (§5/§6 above) on
   the new origin. Record evidence before removing any legacy hostname.

None of this was executed in Task 058: no domain was purchased or bound, no
Supabase Auth setting changed, no monitor updated, and no smoke run against a
custom origin took place.

### 8.1 Task 059 — staging evidence vs production readiness (2026-09-10)

Task 059 acquired `patihatti.com`, applied the `Pati Hattı` public brand and
bound **staging only**. Nothing below authorizes production activation. The
production application origin `app.patihatti.com` is **reserved and
deliberately not routed**: it must never resolve to the staging Worker or the
staging Supabase project.

| §8 step | Staging (`staging.patihatti.com`) | Production (`app.patihatti.com`) |
| --- | --- | --- |
| 1. Hostname | `PASS` — owner acquired `patihatti.com`; staging host chosen | `NOT RUN` — hostname reserved only |
| 2. Cloudflare binding | `PASS` — `custom_domain` route in `wrangler.staging.toml`; `workers.dev` retained | `NOT RUN` — no route, no deploy |
| 3. Supabase Auth | `PASS` — exact entries, no wildcard; staff sign-in, admin AAL2 and the password-recovery redirect were exercised from the custom origin | `NOT RUN` |
| 4. Edge checks | `PASS` — four endpoints and both panel CSP headers verified below | `NOT RUN` |
| 5. E-mail subdomain | `PASS` — `mail.patihatti.com` shows `Verified` in Resend; no e-mail was sent from it | `NOT RUN` |
| 6. Smoke + evidence | `NOT RUN` — no WhatsApp canary or bounded alert proof was run **from the custom origin** | `NOT RUN` |

Endpoints independently re-verified on the custom origin on 2026-09-10 by the
reviewing session rather than taken from a report:

- `GET /health` -> `200 {"status":"ok","version":"0.1.0", ...}`
- `GET /ready` -> `200 {"status":"ready"}`
- `GET /staff/config.json` -> `200`, returns the **staging** Supabase project
- `GET /admin/config.json` -> `200`, returns the **staging** Supabase project
- `GET /staff` -> renders the Task 058 panel shell; document title
  `Pati Hattı Personel Paneli`; staff tabs correctly absent before sign-in

Authenticated flows subsequently exercised on the custom origin:

- `/admin` — password sign-in plus TOTP AAL2 challenge, then the clinic
  overview rendered. This is meaningful evidence rather than a page load: the
  overview RPC rejects any caller whose JWT `aal` claim is not exactly `aal2`,
  so a rendered table proves the second factor and the redirect allow-list both
  worked through this origin.
- `/staff` — password sign-in, then the work-item queue rendered.
- Password recovery — Supabase sent one bounded recovery e-mail on 2026-09-11;
  the owner opened it without sharing the fragment/token, and it landed on
  `https://staging.patihatti.com/admin` with the `Yeni parola belirle` view.

The reviewing Codex session also read both live panel response headers on
2026-09-11. `/staff` and `/admin` returned the exact CSP values pinned by the
green route tests; neither origin relaxed the reviewed browser trust boundary.

Deliberately **not** claimed as verified: no WhatsApp canary or bounded alert
proof was run specifically from the custom browser origin, no e-mail was sent
from the newly verified Resend domain, and production remains untouched. The
`workers.dev` hostname remains available as a staging fallback.

Operational alerting stayed disabled throughout
(`OPERATIONAL_ALERTS_ENABLED = "false"` in both Wrangler configs); Task 059
sent no clinic or platform alert e-mail.
