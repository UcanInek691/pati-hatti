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
const robots = read("public/robots.txt");
const sitemap = read("public/sitemap.xml");
const mediaAssets = [
  "public/assets/pati-hatti-garden-static.webp",
  "public/assets/pati-hatti-dog-sprites.webp",
  "public/assets/pati-cursor.png",
  "public/assets/pati-hatti-share.png",
];

describe("Task 063 homepage static assets", () => {
  it("public/** files exist and are non-empty", () => {
    for (const content of [html, css, js, headers, robots, sitemap]) {
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

  it("uses absolute URLs only for the declared production origin and schema vocabularies", () => {
    const urls = [html, css, js, headers, robots, sitemap]
      .flatMap((content) => content.match(/https?:\/\/[^\s"'<>]+/g) ?? [])
      .map((url) => url.replace(/[),.;]+$/, ""));
    expect(new Set(urls)).toEqual(new Set([
      "https://patihatti.com/",
      "https://patihatti.com/assets/pati-hatti-share.png",
      "https://patihatti.com/sitemap.xml",
      "https://schema.org",
      "http://www.sitemaps.org/schemas/sitemap/0.9",
    ]));
  });

  it("has no inline executable script, style block, or inline event handler", () => {
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts).toHaveLength(2);
    const inline = scripts.filter((match) => !/\bsrc=/.test(match[1] ?? ""));
    expect(inline).toHaveLength(1);
    expect(inline[0]![1]).toContain('type="application/ld+json"');
    expect(() => JSON.parse(inline[0]![2] ?? "")).not.toThrow();
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

  it("uses the hero reveal for clinic controls instead of duplicating the four-step explainer", () => {
    const pilotSection = html.match(/<section class="pilot-panel"[\s\S]*?<\/section>/);
    expect(pilotSection).not.toBeNull();
    expect(pilotSection![0]).toContain("Klinik kontrol merkezi");
    expect(pilotSection![0]).toContain("Mesajlar tek yerde");
    expect(pilotSection![0]).toContain("Karar klinikte");
    expect(pilotSection![0]).toContain("Güvenlik görünür");
    expect(pilotSection![0]).not.toContain("Nasıl çalışır");
    expect(html).toContain('id="nasil-calisir"');
  });

  it("binds production discovery metadata to the exact apex marketing URL", () => {
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).toContain('<meta property="og:locale" content="tr_TR" />');
    expect(html).toContain('<meta property="og:site_name" content="Pati Hattı" />');
    expect(html).toContain('<link rel="canonical" href="https://patihatti.com/" />');
    expect(html).toContain('<meta property="og:url" content="https://patihatti.com/" />');
    expect(html).toContain('<meta property="og:image" content="https://patihatti.com/assets/pati-hatti-share.png" />');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="twitter:image" content="https://patihatti.com/assets/pati-hatti-share.png" />');
    expect(html).toContain('<meta name="theme-color" content="#f4eadb" />');
    expect(html).toContain('<link rel="icon" type="image/png" href="/assets/pati-cursor.png" />');
    const jsonLd = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(jsonLd).toBeDefined();
    expect(JSON.parse(jsonLd!)).toEqual({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: "Pati Hattı",
      url: "https://patihatti.com/",
      inLanguage: "tr-TR",
      description: "Veteriner klinikleri için WhatsApp karşılama, bilgi toplama, randevu ve kontrollü insan devri deneyimi.",
    });
    expect(jsonLd).not.toContain("Organization");
  });

  it("ships an exact one-page sitemap and a conservative indexing policy", () => {
    expect(sitemap.match(/<url>/g)).toHaveLength(1);
    expect(sitemap).toContain("<loc>https://patihatti.com/</loc>");
    expect(sitemap).not.toMatch(/\/staff|\/admin|\/privacy|staging|workers\.dev/i);
    expect(robots).toContain("Allow: /");
    expect(robots).toContain("Disallow: /staff");
    expect(robots).toContain("Disallow: /admin");
    expect(robots).toContain("Disallow: /privacy");
    expect(robots).toContain("Sitemap: https://patihatti.com/sitemap.xml");
  });

  it("ships the original share card at the declared 1200x630 dimensions", () => {
    const png = readFileSync(path.join(ROOT, "public/assets/pati-hatti-share.png"));
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
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

  test("uses wide desktop space without stretching long-form copy", () => {
    expect(css).toMatch(/\.stage\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none/);
    expect(css).toMatch(/\.scene-wrap\s*\{[^}]*width:\s*min\(100%,\s*calc\(\(100vh - 84px\) \* 16 \/ 9\)\)/);
    expect(css).toMatch(/\.content-section\s*\{[^}]*max-width:\s*1120px/);
    expect(css).toMatch(/#sss,\s*\.closing-section\s*\{[^}]*max-width:\s*900px/);
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

  test("removes the ineffective gaze overlay and all pointer-tracking code", () => {
    expect(html + css + js).not.toMatch(/gaze-eyes|gaze-eye|gaze-pupil|GAZE_RANGE_PX|--gaze-[xy]|pupils/);
    expect(js).not.toContain('addEventListener("pointermove"');
    expect(js).not.toContain('addEventListener("pointerleave"');
  });

  test("uses the owner-provided paw as a warm-brown cursor only on fine-pointer devices", () => {
    const cursorAsset = path.join(ROOT, "public/assets/pati-cursor.png");
    expect(statSync(cursorAsset).size).toBeGreaterThan(0);
    expect(statSync(cursorAsset).size).toBeLessThan(10_000);
    expect(css).toMatch(/@media \(pointer: fine\)[\s\S]*url\("\/assets\/pati-cursor\.png"\) 16 16, auto/);
    expect(css).toMatch(/@media \(pointer: fine\)[\s\S]*url\("\/assets\/pati-cursor\.png"\) 16 16, pointer/);
    expect(css).not.toMatch(/@media \(pointer: coarse\)[\s\S]*pati-cursor/);
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
