# Current task — 025 Türkçe insan onay paketleri

Status: `COMPLETE`

Owner: Codex

## Goal

Create two plain-Turkish, non-technical review documents:

1. one veterinarian review pack containing every current user-facing safety
   and appointment message, its trigger, system limitations, and an approval
   record;
2. one KVKK/legal review worksheet containing the verified data flow,
   inventory, access boundaries, erasure behavior, vendor-transfer questions,
   retention-decision blanks, and an approval record.

The documents must help human experts review the actual MVP without reading
source code. They must not invent clinical guidance, choose a legal basis,
set retention periods, or claim that AI review replaces professional approval.

## Scope

Allowed changes:

- `docs/veteriner-hekim-onay-paketi.md` (new)
- `docs/kvkk-inceleme-paketi.md` (new)
- `docs/production-readiness.md` (links only)
- `README.md` (links only)
- `PROJECT_CONTEXT.md` (durable documentation fact only)
- `CURRENT_TASK.md`

No runtime, prompt, migration, dependency, infrastructure, secret, database,
deployment, or external-service change.

## Acceptance criteria

- All fixed Turkish intake and appointment copy matches reviewed source at
  commit `0a3e13d`; dynamic appointment time is shown as a placeholder.
- The veterinarian pack explains emergency/handoff behavior, safety-question
  precedence, temporary appointment holds, and that staff visibility is not a
  notification.
- The KVKK pack distinguishes verified technical facts from decisions the
  legal reviewer must make, including controller/processor roles, legal bases,
  notice timing, overseas transfers, retention, erasure/export, and provider
  agreements.
- The KVKK pack links only to current official KVKK resources for legal
  reference and makes no compliance claim.
- Both packs contain reviewer identity/date/version/decision fields and state
  that signed copies should be stored outside the public repository.
- Markdown is Turkish, readable without engineering knowledge, and passes
  `git diff --check`.

## Verification

- Compare every quoted product message to source.
- Check links and headings manually.
- Run `git diff --check` and verify the worktree contains only allowed files.

## Delivery record

Completed by Codex on 2026-08-10.

- Added `docs/veteriner-hekim-onay-paketi.md` with all 11 current reply
  situations, the eight exact safety questions, plain-language runtime
  boundaries, per-message decision fields, and a versioned sign-off record.
- Added `docs/kvkk-inceleme-paketi.md` with the verified data flow and
  inventory, blank processing/legal-basis and retention tables, overseas
  transfer/provider checks, data-subject request workflow, security facts,
  official KVKK reference links, and a sign-off record.
- Linked both packs from `README.md` and the production human-gate checklist.
- Updated durable project context without changing any runtime, prompt,
  migration, dependency, infrastructure, secret, or external system.
- Compared every fixed quoted message and all eight safety questions against
  source at `0a3e13d`: `COPY_AND_LINK_CHECK_PASS`.
- Official KVKK pages for notice requirements, processing inventory,
  deletion/destruction, data-subject applications, controller/processor
  roles, and overseas transfers were checked on 2026-08-10.
- `git diff --check` passed. No production approval is claimed; the packs are
  ready for the named human experts to complete outside the repository.
