import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, test } from "vitest";

const ROOT = path.join(__dirname, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

const html = read("public/index.html");
const css = read("public/styles.css");
const js = read("public/app.js");
const headers = read("public/_headers");
const mediaAssets = [
  "public/assets/pati-hatti-garden-static.webp",
  "public/assets/pati-hatti-dog-sprites.webp",
];

describe("Task 063 homepage static assets", () => {
  it("public/** files exist and are non-empty", () => {
    for (const content of [html, css, js, headers]) {
      expect(content.length).toBeGreaterThan(0);
    }
    for (const asset of mediaAssets) {
      expect(statSync(path.join(ROOT, asset)).size).toBeGreaterThan(0);
    }
  });

  it("keeps the complete rendered transition package bounded", () => {
    const totalBytes = mediaAssets.reduce(
      (total, asset) => total + statSync(path.join(ROOT, asset)).size,
      0
    );
    expect(totalBytes).toBeLessThan(1_500_000);
  });

  it("references no remote origin from any public file", () => {
    for (const content of [html, css, js, headers]) {
      expect(content).not.toMatch(/https?:\/\//);
    }
  });

  it("index.html has no inline script, style block, or inline event handler", () => {
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[^<]/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
  });

  it("loads app.js and styles.css only as same-origin external files", () => {
    expect(html).toContain('<link rel="stylesheet" href="/styles.css" />');
    expect(html).toContain('<script src="/app.js" defer></script>');
  });

  it("keeps product copy inside the verified boundary", () => {
    expect(html).toContain("WhatsApp");
    expect(html).toContain("randevu");
    expect(html).toContain("Veteriner girişi");
    expect(html).toContain("teşhis koymaz");
    expect(html).toContain("ilaç önermez");
    expect(html).toContain("garantisi vermez");
  });

  it("contains no fabricated clinic, person, testimonial or contact content", () => {
    expect(html).not.toContain("Örnek Klinik");
    expect(html).not.toContain("Staging örneği");
    expect(html).not.toContain("Yer tutucu profil");
    expect(html).not.toMatch(/testimonial|referans|müşteri yorumu/i);
    expect(html).not.toMatch(/(?<![\d/])\d+\+?\s*(klinik|partner|müşteri)/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/mailto:|@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("states pilot applications are not yet open and keeps /staff as the only live action inside the reveal", () => {
    expect(html).toContain("Herkese açık pilot başvurusu");
    expect(html).toContain("henüz açık");
    const pilotSection = html.match(/<section class="pilot-panel"[\s\S]*?<\/section>/);
    expect(pilotSection).not.toBeNull();
    expect(pilotSection![0]).not.toMatch(/<a\b|<form\b|<button\b/);
  });

  it("states appointment confirmation requires the owner's explicit EVET reply", () => {
    expect(html).toContain('"EVET"');
    expect(html).toContain("kesinleşmez");
  });

  it("pins the finite state machine's state names", () => {
    expect(js).toContain('HOME: "home"');
    expect(js).toContain('HOPPING_RIGHT: "hopping-right"');
    expect(js).toContain('RIGHT: "right"');
    expect(js).toContain('APPROACHING: "approaching"');
    expect(js).toContain('NETWORK: "network"');
    expect(js).toContain('RETURNING: "returning"');
  });

  it("pins the double-activation transition guard", () => {
    expect(js).toContain("if (state === STATES.HOME) {");
    expect(js).toContain("} else if (state === STATES.RIGHT) {");
    expect(js).toContain("} else if (state === STATES.NETWORK) {");
    expect(js).toContain("Any other state means a transition is already in flight: ignored.");
  });

  it("never stores or transmits pointer data", () => {
    expect(js).not.toMatch(/localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest|navigator\.sendBeacon/);
  });

  it("pins the reduced-motion path in both script and stylesheet", () => {
    expect(js).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("prefers-reduced-motion: reduce");
  });

  it("uses real buttons for the dog and primary action, not clickable divs", () => {
    expect(html).toMatch(/<button[^>]*id="dog-trigger"/);
    expect(html).toMatch(/<button[^>]*id="how-it-works"/);
  });

  it("keeps the pilot panel readable without JavaScript", () => {
    const openingTag = html.match(/<section class="pilot-panel" id="pilot"[^>]*>/)?.[0];
    expect(openingTag).toBeDefined();
    expect(openingTag).not.toMatch(/hidden/);
  });

  it("ships a strict, same-origin-only security policy with no unsafe-inline", () => {
    expect(headers).toContain("Content-Security-Policy");
    expect(headers).toContain("default-src 'none'");
    expect(headers).toContain("media-src 'self'");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).not.toContain("unsafe-inline");
    expect(headers).not.toContain("unsafe-eval");
  });
});

describe("Task 063 Static Assets Wrangler configuration", () => {
  it("declares an identical, binding-free [assets] block in production and staging", () => {
    const prod = read("wrangler.toml");
    const staging = read("wrangler.staging.toml");
    for (const config of [prod, staging]) {
      expect(config).toContain("[assets]");
      expect(config).toContain('directory = "./public"');
      expect(config).not.toMatch(/binding\s*=\s*"ASSETS"/);
    }
  });
});

describe("Task 063 hero scene structure", () => {
  test("composes the rendered garden, real copy and controls in one cinematic scene", () => {
    const sceneOpen = html.indexOf('<div class="scene" id="scene"');
    const sceneClose = html.indexOf("</div>\n    </div>", sceneOpen);
    const mediaOpen = html.indexOf('<div class="scene-media">', sceneOpen);
    const heroOpen = html.indexOf('<div class="hero-copy">', sceneOpen);
    const pilotOpen = html.indexOf('<section class="pilot-panel" id="pilot"', sceneOpen);

    expect(sceneOpen).toBeGreaterThan(-1);
    expect(mediaOpen).toBeGreaterThan(sceneOpen);
    expect(heroOpen).toBeGreaterThan(mediaOpen);
    expect(pilotOpen).toBeGreaterThan(heroOpen);
    expect(sceneClose).toBeGreaterThan(pilotOpen);
    expect(css).toMatch(/\.scene\s*\{[^}]*aspect-ratio:\s*16 \/ 9/);
    expect(css).toMatch(/\.hero-copy\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/html\.js \.pilot-panel\s*\{[^}]*position:\s*absolute/);
  });

  test("pilot panel is nested inside the same #scene box, not a separate subsection", () => {
    const sceneOpen = html.indexOf('<div class="scene" id="scene"');
    const sceneWrapOpen = html.indexOf('<div class="scene-wrap">');
    expect(sceneOpen).toBeGreaterThan(-1);

    const pilotMatches = [...html.matchAll(/<section class="pilot-panel" id="pilot"[^>]*>/g)];
    // Exactly one pilot panel, and it must sit after the scene box opens.
    expect(pilotMatches).toHaveLength(1);
    const pilotOpen = pilotMatches[0]!.index as number;
    expect(pilotOpen).toBeGreaterThan(sceneOpen);

    // Find the </div> that closes .scene-wrap by tracking div nesting depth
    // from its opening tag, so we can prove the pilot panel closes before
    // the scene box does (i.e. it is a descendant of the scene, not a sibling
    // section placed after it).
    let depth = 0;
    let cursor = sceneWrapOpen;
    const divTag = /<div\b[^>]*>|<\/div>/g;
    divTag.lastIndex = sceneWrapOpen;
    let sceneWrapClose = -1;
    let match: RegExpExecArray | null;
    while ((match = divTag.exec(html))) {
      if (match[0].startsWith("</div>")) {
        depth -= 1;
        if (depth === 0) {
          sceneWrapClose = match.index;
          break;
        }
      } else if (!match[0].endsWith("/>")) {
        depth += 1;
      }
      cursor = match.index;
    }
    expect(cursor).toBeGreaterThanOrEqual(sceneWrapOpen);
    expect(sceneWrapClose).toBeGreaterThan(pilotOpen);
  });

  test("uses one immutable background and one transparent character sheet", () => {
    for (const asset of mediaAssets) {
      expect(html + css + js).toContain(asset.replace("public", ""));
    }
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<audio");
    expect(html).not.toMatch(/autoplay/i);
    expect(js).not.toMatch(/\.play\(|currentTime|playbackRate/);
    expect(css).toContain('background: url("/assets/pati-hatti-dog-sprites.webp")');
    expect(css).toContain("@keyframes hop-right");
    expect(css).toContain("@keyframes run-toward-camera");
    expect(css).toContain("@keyframes hop-home");
  });

  test("aligns two bounded irises and moving pupils with both settled dog poses", () => {
    expect(html.match(/class="gaze-eye"/g)).toHaveLength(2);
    expect(html.match(/class="gaze-pupil"/g)).toHaveLength(2);
    expect(css).toMatch(/\.gaze-eye\s*\{[^}]*left:\s*49%[^}]*top:\s*24%/);
    expect(css).toMatch(/\.gaze-eye \+ \.gaze-eye\s*\{[^}]*left:\s*61\.5%[^}]*top:\s*24%/);
    expect(css).toMatch(/\.gaze-eye\s*\{[^}]*background:\s*transparent/);
    expect(css).toMatch(/\.gaze-pupil\s*\{[^}]*background:\s*#2c1d16/);
    expect(css).toMatch(/\.gaze-pupil\s*\{[^}]*var\(--gaze-x\)[^}]*var\(--gaze-y\)/);
    expect(js).toContain("var GAZE_RANGE_PX = 2.2;");
  });

  test("keeps the scene deterministic and free of generated-video background churn", () => {
    const shadeRule = css.match(/\.scene-shade\s*\{[^}]*\}/);
    expect(shadeRule).not.toBeNull();
    expect(shadeRule![0]).not.toContain("radial-gradient");
    expect(html).toContain('class="scene-background"');
    expect(js).not.toMatch(/\.src\s*=|setAttribute\(["']src/);
  });

  test("shows three capability/role cards, not fake identities, without an internal desktop scrollbar", () => {
    expect(html.match(/class="role-card"/g)).toHaveLength(3);
    expect(html).not.toMatch(/class="role-card"[\s\S]{0,200}<svg/);
    expect(css).toMatch(/\.role-cards\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
    const panelRule = css.match(/\.pilot-panel\s*\{[^}]*\}/);
    expect(panelRule).not.toBeNull();
    expect(panelRule![0]).not.toMatch(/overflow-y:\s*(auto|scroll)/);
  });
});

describe("Task 063 completed page sections", () => {
  it("header, skip link and every named section exist once with matching same-page anchors", () => {
    expect(html.match(/class="skip-link"/g)).toHaveLength(1);
    expect(html).toContain('href="#main-content"');
    expect(html.match(/id="main-content"/g)).toHaveLength(1);

    const destinations = ["nasil-calisir", "klinikler-icin", "guvenlik", "sss"];
    for (const id of destinations) {
      expect(html.match(new RegExp(`href="#${id}"`, "g"))).toHaveLength(1);
      expect(html.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }

    expect(html.match(/<header class="brand-bar">/g)).toHaveLength(1);
    expect(html.match(/<footer class="site-footer">/g)).toHaveLength(1);
    expect(html).toMatch(/<footer[^>]*>[\s\S]*href="\/privacy"[\s\S]*href="\/staff"[\s\S]*<\/footer>/);
  });

  it("keeps a logical heading order: one h1, then only h2/h3 below it", () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const afterH1 = html.slice(html.indexOf("<h1") + 1);
    const headingLevels = [...afterH1.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    expect(headingLevels).not.toContain(1);
    for (let i = 1; i < headingLevels.length; i += 1) {
      expect(headingLevels[i]!).toBeLessThanOrEqual(headingLevels[i - 1]! + 1);
    }
  });

  it("explains the four-step flow without claiming a message alone is a confirmed appointment", () => {
    expect(html.match(/class="step"/g)).toHaveLength(4);
    expect(html).toContain("bir mesaj tek başına onaylanmış bir\n          randevu değildir");
  });

  it("lists implemented clinic controls without unsupported promises", () => {
    expect(html).toContain("Europe/Istanbul");
    expect(html).toContain("çalışma saatlerini");
    expect(html).toContain("kapalı günler");
    expect(html).toContain("otomatik, manuel veya kişisel mod");
    expect(html).toContain("desteklenmeyen entegrasyon");
  });

  it("presents a visible Yapar/Yapmaz safety boundary and flags pending veterinary approval", () => {
    expect(html).toContain(">Yapar<");
    expect(html).toContain(">Yapmaz<");
    expect(html).toContain("hastalık listelemez");
    expect(html).toContain("doz önermez");
    expect(html).toContain("Tedavi planı oluşturmaz");
    expect(html).toContain("botu beklemeyin");
    expect(html).toContain("hâlâ beklenmektedir");
  });

  it("renders the FAQ as native, no-JS-readable details/summary entries", () => {
    const items = html.match(/<details class="faq-item">/g) || [];
    expect(items.length).toBeGreaterThanOrEqual(6);
    const summaries = html.match(/<summary>/g) || [];
    expect(summaries.length).toBe(items.length);
    expect(html).toMatch(/<details class="faq-item">\s*<summary>[^<]+<\/summary>/);
  });

  it("defines explicit tablet/phone breakpoints, focus-visible states, anchor scroll margin, and no internal scrollbar", () => {
    expect(css).toMatch(/@media \(max-width: 768px\)/);
    expect(css).toMatch(/@media \(max-width: 420px\)/);
    expect(css).toMatch(
      /@media \(max-width: 768px\)[\s\S]*html\.js \.pilot-panel\s*\{[^}]*position:\s*relative[^}]*inset:\s*auto[^}]*width:\s*auto/
    );
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/scroll-margin-top/);
    expect(css).not.toMatch(/overflow-y:\s*(auto|scroll)/);
  });

  it("does not add any new dependency, form backend, or third-party runtime", () => {
    expect(html).not.toMatch(/<form\b/i);
    expect(html + css + js).not.toMatch(/analytics|gtag|dataLayer|hotjar|sentry/i);
  });
});
