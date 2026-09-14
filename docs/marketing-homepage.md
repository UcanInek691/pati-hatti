# Task 061/063/064 — Marketing homepage

The public `/` route is a dependency-free, same-origin marketing homepage
served from `public/**` through the binding-free Static Assets configuration in
both Wrangler files. Unmatched requests still fall through to `src/index.ts`, so
`/staff`, `/admin`, `/privacy`, `/health`, `/ready`, webhooks and Queue behavior
remain Worker-owned.

Task 063 turned the Task 061 hero prototype into a complete product page: a
header with skip link and section nav, the existing hero, then `#nasil-calisir`,
`#klinikler-icin`, `#guvenlik`, `#sss` and a closing/footer section — with the
old fake clinic/person cards inside the hero reveal replaced by an honest
pilot-status panel.

## Current implementation

- `public/index.html` keeps the story, CTA, Golden Retriever trigger and the
  `#pilot` reveal panel in one `#scene` (the reveal is not a separately scrolled
  page section). Below the hero, `#nasil-calisir` (4-step flow), `#klinikler-icin`
  (clinic controls), `#guvenlik` (Yapar/Yapmaz safety boundary) and `#sss`
  (native `<details>/<summary>` FAQ) complete the page, followed by a closing
  staff-login section and a footer linking `/privacy` and `/staff`.
- `#pilot` (formerly `#network`) no longer shows any fake clinic name, portrait,
  testimonial or partner count. Task 064 also stopped using this reveal as a
  second "Nasıl çalışır" explainer: it now introduces the clinic control
  centre through message organization, human control and the medical-safety
  boundary. Public pilot applications/contact remain explicitly closed.
- `public/styles.css` supplies the responsive 16:9 game scene, text treatment,
  focus states, approximately 44px targets and the desktop/mobile layouts, plus
  the new content sections' layout (step list, control grid, boundary columns,
  FAQ list, footer). The three pilot role cards fit without an internal
  scrollbar at 1280×720 and 375×812.
- `public/app.js` owns the bounded state machine
  `home -> hopping-right -> right -> approaching -> network -> returning ->
  home`. The first activation bounds right, the second keeps the mascot at a
  stable apparent size while the fixed scenery recedes, and the third uses a
  genuinely left-facing bound pose to return. Repeated activation while moving
  is ignored; `animationend` plus a bounded timeout settles every transition.
  The pinned `STATES.NETWORK: "network"` state name is unchanged; only the DOM
  id/class of the reveal panel it drives (`#pilot` / `.pilot-panel`) was renamed.
- `public/_headers` keeps the strict default-deny CSP and permits only same-origin
  scripts, styles, images and media. Unchanged by Task 063 — no new same-origin
  asset required a CSP addition.
- `public/assets/` contains one immutable WebP garden, one transparent WebP
  sheet with four coherent mascot poses, and the owner's paw silhouette reduced
  to a 32×32 transparent warm-brown PNG cursor. The browser never generates,
  swaps or plays a background video.

The complete runtime art is under 400 KiB. No remote runtime asset, analytics
call or storage is used.

## Art direction and provenance

The first SVG attempts and later full-frame generated videos were rejected: the
SVG was too elementary, while video generation changed scenery and lighting
between frames. The current prototype separates the art deliberately. A single
empty garden is immutable; only a transparent four-pose Golden Retriever layer
moves. The mascot keeps the same face, cream-gold coat, floppy ears, red
neckerchief and round tag in every pose. Motion is deterministic CSS, so trees,
kennel, stones and light cannot morph or flicker.

This is still a **local visual prototype, not yet a production-cleared brand
asset**. The fixed background and transparent pose sheet were produced with the
built-in ImageGen workflow using the owner-approved clean scene frames as visual
references. Before publication on `patihatti.com`, staging or production, the
owner must record that provenance and confirm commercial permission; otherwise
the two assets must be replaced by a licensed or commissioned equivalent and the
same visual and transfer-size checks rerun.

The dog is therefore a direction-setting mascot prototype, not yet the final
logo or permanent character sheet. A future clean export should preserve the
identifying choices established here rather than regenerate a generic Golden:
floppy ears, warm cream-gold coat, red neckerchief and round tag, friendly but
not infant-like proportions, fixed-camera garden world and the kennel-to-sit
movement.

## Interaction and accessibility

- A skip link and header nav (`Nasıl çalışır`, `Klinikler için`, `Güvenlik`,
  `SSS`, `/staff`) sit before the hero. `Bahçeyi keşfet` and the mascot are
  native buttons; mouse, touch, Enter and Space use the same transition
  function. The second step is labelled `Kontrol merkezini gör`; the actual
  four-step product explanation remains exclusively below the hero.
- The fixed scene and mascot layer are decorative. State changes update the
  button label for the three-step path and keep `#pilot` inert and
  `aria-hidden` until it is revealed.
- With JavaScript disabled, the full page — hero copy, `#pilot`, and every
  content section below it — remains readable. Task 063 fixed a pre-existing
  no-JS-only bug: without `html.js`, `#pilot` was never hidden and, being
  absolutely positioned, rendered on top of the hero copy. `html:not(.js)` now
  switches `.scene` to the same flex-column static-flow layout the mobile media
  query already used, so `#pilot` flows below the hero copy instead of
  overlapping it, at any viewport width.
- The rejected pupil overlay and its pointer listeners were removed completely.
  Fine-pointer devices use the small paw cursor with native `auto`/`pointer`
  fallbacks; touch/coarse-pointer devices keep their platform cursor behavior.
- Reduced-motion users receive immediate state changes without CSS travel.
- The FAQ uses native `<details>/<summary>`, so every question is readable and
  independently expandable without JavaScript.

## Security and product boundaries

There are no inline scripts/styles/handlers and no third-party runtime origins.
The CSP is `default-src 'none'` with narrowly scoped same-origin opt-ins including
`media-src 'self'`; `nosniff` and `Referrer-Policy: no-referrer` remain enabled.
The page does not diagnose, promise medical availability, submit a form, or name
a real partner clinic. Every product/clinic-control claim traces to a specific,
already-shipped behavior recorded in `PROJECT_CONTEXT.md` (30-minute slots with a
10-minute hold, the "EVET" confirmation keyword, Europe/Istanbul-rendered times,
ai/manual/personal per-contact automation modes, the urgent-first staff queue,
per-clinic operational hours/closures, e-mail/browser alert preferences, and
Red-priority automation-stop behavior). No pricing, customer, SLA, 24/7-service,
delivery guarantee or sales contact is stated because none is verified; `#guvenlik`
explicitly discloses that renewed veterinary approval for the reordered safety
questions is still pending.

## Verification

Codex exercised Task 063 through the real local Worker in the in-app Chromium
browser at 1440×900, 768×1024 and 375×812. The initial hero, all page sections,
header anchors, native FAQ keyboard behavior and the complete
`home -> right -> network -> home` interaction were rendered. No horizontal
document overflow or internal content scrollbar was present. During that pass,
Codex found and fixed two responsive defects: the tablet breakpoint excluded
the exact 768 px acceptance viewport, and a higher-specificity desktop rule
kept the revealed pilot panel absolutely positioned on narrow screens. The
targeted tests and rendered tablet/phone states were repeated after the fix.

JavaScript was also temporarily disabled at 768×1024 to render the no-JS path:
the pilot panel followed the hero in normal document flow with zero overlap,
and the application script was restored immediately afterward. This browser
surface did not expose reduced-motion media emulation, so the actual rendered
`prefers-reduced-motion` mode remains **NOT RUN**; the unchanged reduced-motion
rules and state-machine fallback remain covered by source review and automated
tests, not represented as rendered proof.

Task 061 results, still valid for the hero itself:

- At 1280×720 the kennel, Golden, copy and CTA are all in the first viewport.
  The complete three-activation flow reached `right`, `network` and then `home`;
  focus returned to the mascot each time.
- The settled desktop network panel had `scrollHeight === clientHeight` and
  `scrollWidth === clientWidth`; the document had no horizontal overflow.
- At 375×812 the home and network states had no horizontal overflow. The three
  cards remained visible without an internal scrollbar, and native Enter on the
  focused `Eve dön` button completed the return transition.
- The last visual pass rejected full-frame video because its background changed
  between frames. Replacing it with one fixed background plus transparent poses
  removed that failure mode rather than hiding it.
- Task 064 deliberately removed the gaze hit area and pupil overlays after the
  owner found the effect visually incorrect. The mascot raster and all three
  accepted movement phases are unchanged.

Automated verification pins the same-origin fixed background and pose sheet, the
absence of video/reverse playback, all three CSS motion phases, bounded asset
budget, no-JS content, accessibility labels, strict CSP and the non-scrolling
pilot panel — plus, for Task 063, the header/nav/footer structure, the four new
content sections' required statements, the absence of every fabricated-content
marker, and the native FAQ markup.
Exact command results are recorded in `CURRENT_TASK.md` after the final gate run.

Task 063 is committed at repository closure. No push, staging/production
deploy, DNS change or external-service activation is part of this task.

## Task 064 pre-launch SEO boundary

Task 064 added a focused Turkish page title and description plus Open Graph
(`website`, `tr_TR`, site name, title, description) and Twitter summary-card
metadata. These values contain no fabricated organization, customer, URL or
medical promise and work without a third-party runtime.

Task 067 binds the public marketing identity to the owner-confirmed apex
`https://patihatti.com/`: one canonical, matching `og:url`, a same-origin
1200×630 social card, Twitter large-card metadata, a one-URL sitemap and a
conservative robots policy. The social card is a deterministic typographic
asset with no garden, mascot, customer, clinic or third-party material, so it
does not inherit the hero assets' open commercial-provenance decision.

The page now publishes `WebSite` JSON-LD only. `Organization` remains deferred
because no approved legal publisher identity exists in repository evidence;
inventing one would be less accurate than omitting it. Staff/admin and the
staging privacy surface explicitly remain `noindex, nofollow, noarchive`.
Task 068 deployed these exact files through a separate asset-only Cloudflare
Worker at the apex. The live HTML, image, robots and sitemap returned 200 over
HTTPS, and non-marketing paths including `/staff`, `/admin`, `/privacy`,
`/health`, `/ready` and `/webhooks/whatsapp` returned 404. This is public-site
deployment proof only: `app.patihatti.com` remains unbound and no product
runtime, authentication, webhook, queue, Cron, alert or clinical behavior was
activated.

## Local preview

```text
pnpm exec wrangler dev
```

Open the printed local URL. `/` comes directly from `public/**`; there is no
homepage build step.

## Wide-desktop composition

Task 065 removes the hero stage's obsolete 1280 px ceiling while retaining the
existing viewport-height-aware 16:9 limit. The garden therefore grows to use a
wide desktop confidently without becoming taller than the first viewport. At
1920×1080 the rendered scene grows from 1280 px to roughly 1770 px and remains
centered with no horizontal overflow.

Structured card sections use a 1120 px desktop container. The FAQ and closing
copy remain capped at 900 px, and headings, notes and paragraphs retain their
existing character-based measures, so the extra width benefits the grids
without creating hard-to-read long lines. Tablet and phone breakpoints are
unchanged.
