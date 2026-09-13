# Task 061 — Marketing homepage

The public `/` route is a dependency-free, same-origin marketing homepage
served from `public/**` through the binding-free Static Assets configuration in
both Wrangler files. Unmatched requests still fall through to `src/index.ts`, so
`/staff`, `/admin`, `/privacy`, `/health`, `/ready`, webhooks and Queue behavior
remain Worker-owned.

## Current implementation

- `public/index.html` keeps the story, CTA, Golden Retriever trigger and clinic
  preview in one `#scene`. The preview is not a separately scrolled page section.
- `public/styles.css` supplies the responsive 16:9 game scene, text treatment,
  focus states, approximately 44px targets and the desktop/mobile layouts. The
  three clinic cards fit without an internal scrollbar at 1280×720 and 375×812.
- `public/app.js` owns the bounded state machine
  `home -> hopping-right -> right -> approaching -> network -> returning ->
  home`. The first activation bounds right, the second keeps the mascot at a
  stable apparent size while the fixed scenery recedes, and the third uses a
  genuinely left-facing bound pose to return. Repeated activation while moving
  is ignored; `animationend` plus a bounded timeout settles every transition.
- `public/_headers` keeps the strict default-deny CSP and permits only same-origin
  scripts, styles, images and media.
- `public/assets/` contains one immutable WebP garden and one transparent WebP
  sheet with four coherent mascot poses. The browser never generates, swaps or
  plays a background video.

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

- `Nasıl çalışır?` and the mascot are native buttons; mouse, touch, Enter and
  Space use the same transition function.
- The fixed scene and mascot layer are decorative. State changes update the
  button label for the three-step path and keep the clinic preview inert and
  `aria-hidden` until it is revealed.
- With JavaScript disabled, the truthful product copy and placeholder clinic
  preview remain readable. The three cards explicitly say they represent no real
  clinic or partnership.
- Pointer movement changes only two small dark pupil overlays. No pointer
  coordinates leave the page or enter storage.
- Reduced-motion users receive immediate state changes without CSS travel.

## Security and product boundaries

There are no inline scripts/styles/handlers and no third-party runtime origins.
The CSP is `default-src 'none'` with narrowly scoped same-origin opt-ins including
`media-src 'self'`; `nosniff` and `Referrer-Policy: no-referrer` remain enabled.
The page does not diagnose, promise medical availability, submit a form or name a
real partner clinic.

## Verification

The final remediation was exercised through the real local Worker in the in-app
Chromium browser:

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
- The gaze hit area and pupil coordinates are aligned to the settled mascot;
  only the dark pupils move and no pointer data leaves the page.

Automated verification pins the same-origin fixed background and pose sheet, the
absence of video/reverse playback, all three CSS motion phases, bounded asset
budget, no-JS content, accessibility labels, strict CSP and non-scrolling clinic
panel.
Exact command results are recorded in `CURRENT_TASK.md` after the final gate run.

No commit, push, staging/production deploy, DNS change or external-service
activation is part of Task 061.

## Local preview

```text
pnpm exec wrangler dev
```

Open the printed local URL. `/` comes directly from `public/**`; there is no
homepage build step.
