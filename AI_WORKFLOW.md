# VetAI workflow archive

This file is historical. Active agent instructions and task context now live in:

- `AGENTS.md` — repository-wide working protocol and safety boundaries.
- `PROJECT_CONTEXT.md` — verified durable product and implementation context.
- `CURRENT_TASK.md` — the only active task contract and delivery record.

Do not recover an active task from old chat messages or earlier versions of this file.

## Verified history

- Task 001 established the minimal Cloudflare Worker, health endpoint, and WhatsApp GET verification.
- Codex tightened unsupported POST envelope handling, local secret placeholders, and package-manager configuration. Thirteen tests passed.
- Task 002 added raw-body limits and `X-Hub-Signature-256` verification with Web Crypto.
- Codex made content-type matching exact, made empty app-secret configuration fail closed, and enabled strict UTF-8 decoding. Thirty tests, typecheck, frozen install, and Wrangler dry-run passed.
- Secure product-code baseline: `e50a2f7`.
- Context workflow baseline before this migration: `a9ea3f8`.

Full historical prompts remain available in Git history through commit `a9ea3f8` and should be consulted only for audit, not as current instructions.
