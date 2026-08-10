# Current task — 026 Türkçe onay paketlerini PDF'e dönüştürme

Status: `COMPLETE`

Owner: Codex

## Goal

Turn the two reviewed Turkish Markdown approval packs into polished,
print-ready PDFs that a veterinarian and a Turkish law/KVKK specialist can
understand without reading source code.

## Scope

Allowed changes:

- `docs/veteriner-hekim-onay-paketi.md` (plain-language glossary only)
- `docs/kvkk-inceleme-paketi.md` (plain-language glossary only)
- `output/pdf/veteriner-hekim-onay-paketi.pdf` (new)
- `output/pdf/kvkk-inceleme-paketi.pdf` (new)
- `README.md` (PDF links only)
- `PROJECT_CONTEXT.md` (durable artifact fact only)
- `CURRENT_TASK.md`

No runtime, prompt, migration, dependency, infrastructure, secret, database,
deployment, legal decision, clinical decision, or external-service change.

## Acceptance criteria

- Both PDFs preserve the complete approved-source text and blank decision
  fields from their Markdown sources.
- The veterinarian PDF is portrait A4 and explains every technical term needed
  for review in plain Turkish.
- The KVKK PDF uses a readable page orientation and explains technical system
  terms without choosing legal bases or retention periods.
- Turkish glyphs render correctly; tables, checkboxes, links, headings,
  headers, footers, and page numbers are not clipped or overlapping.
- PDFs are reopened, text-extracted, rendered to PNG, and visually inspected.
- `git diff --check` passes and only allowed files remain changed.

## Verification

- Compare PDF text against both Markdown sources with normalized whitespace.
- Use `pdfinfo`, `pypdf`/`pdfplumber`, and Poppler rendering.
- Inspect every rendered page at contact-sheet scale and representative pages
  at full readable size.

## Delivery record

Completed by Codex on 2026-08-10.

- Added plain-Turkish glossaries to both Markdown sources without changing
  clinical copy, legal decisions, retention decisions, or runtime behavior.
- Created `output/pdf/veteriner-hekim-onay-paketi.pdf`: portrait A4, five
  pages, dedicated approval page.
- Created `output/pdf/kvkk-inceleme-paketi.pdf`: landscape A4, nine pages,
  six verified clickable official-KVKK links.
- Used embedded Arial/Arial Bold fonts for complete Turkish glyph support,
  consistent teal/navy hierarchy, repeating table headers, printable blank
  decision fields, headers, footers, and page numbers.
- Reopened both PDFs with `pypdf` and `pdfplumber`; every normalized Markdown
  source segment was present in extracted PDF text, every page contained text,
  and no replacement glyph was found.
- Rendered every page through Poppler. Contact-sheet inspection covered all
  14 pages; full-size inspection covered the veterinarian safety-question
  page, a representative KVKK table page, and the KVKK approval page. No
  clipping, overlap, broken table, black box, or unreadable Turkish glyph was
  found.
- Final verification: veterinarian PDF `PASS` (5 pages, 8052 normalized text
  characters); KVKK PDF `PASS` (9 pages, 6 links, 14866 normalized text
  characters); `git diff --check` passed.
- PDFs are static print/annotation forms, not interactive AcroForms. Signed or
  personally identifying completed copies must remain outside this repository.
