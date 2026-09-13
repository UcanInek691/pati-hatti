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

describe("Task 061 homepage static assets", () => {
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

  it("labels the network preview as a non-production placeholder", () => {
    expect(html).toContain("Staging örneği");
    expect(html).toContain("Yer tutucu profil");
    expect(html).toContain("gerçek bir veteriner");
    expect(html).toContain("kliniği veya iş birliğini temsil etmez");
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

  it("keeps the network section readable without JavaScript", () => {
    const openingTag = html.match(/<section class="network" id="network"[^>]*>/)?.[0];
    expect(openingTag).toBeDefined();
    expect(openingTag).not.toMatch(/hidden|aria-hidden/);
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

describe("Task 061 Static Assets Wrangler configuration", () => {
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

describe("Task 061 hero scene structure", () => {
  test("composes the rendered garden, real copy and controls in one cinematic scene", () => {
    const sceneOpen = html.indexOf('<div class="scene" id="scene"');
    const sceneClose = html.indexOf("</div>\n    </div>", sceneOpen);
    const mediaOpen = html.indexOf('<div class="scene-media">', sceneOpen);
    const heroOpen = html.indexOf('<div class="hero-copy">', sceneOpen);
    const networkOpen = html.indexOf('<section class="network" id="network"', sceneOpen);

    expect(sceneOpen).toBeGreaterThan(-1);
    expect(mediaOpen).toBeGreaterThan(sceneOpen);
    expect(heroOpen).toBeGreaterThan(mediaOpen);
    expect(networkOpen).toBeGreaterThan(heroOpen);
    expect(sceneClose).toBeGreaterThan(networkOpen);
    expect(css).toMatch(/\.scene\s*\{[^}]*aspect-ratio:\s*16 \/ 9/);
    expect(css).toMatch(/\.hero-copy,\s*\n\.network\s*\{[^}]*position:\s*absolute/);
  });

  test("network preview is nested inside the same #scene box, not a separate subsection", () => {
    const sceneOpen = html.indexOf('<div class="scene" id="scene"');
    const sceneWrapOpen = html.indexOf('<div class="scene-wrap">');
    expect(sceneOpen).toBeGreaterThan(-1);

    const networkMatches = [...html.matchAll(/<section class="network" id="network"[^>]*>/g)];
    // Exactly one network section, and it must sit after the scene box opens.
    expect(networkMatches).toHaveLength(1);
    const networkOpen = networkMatches[0]!.index as number;
    expect(networkOpen).toBeGreaterThan(sceneOpen);

    // Find the </div> that closes .scene-wrap by tracking div nesting depth
    // from its opening tag, so we can prove the network section closes before
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
    expect(sceneWrapClose).toBeGreaterThan(networkOpen);
  });

  test("uses one immutable background and one transparent character sheet", () => {
    for (const asset of mediaAssets) {
      expect(html + css + js).toContain(asset.replace("public", ""));
    }
    expect(html).not.toContain("<video");
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

  test("reveals all three demo profiles without an internal desktop scrollbar", () => {
    expect(html.match(/class="profile-card"/g)).toHaveLength(3);
    expect(css).toMatch(/\.profile-cards\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
    const networkRule = css.match(/\.network\s*\{[^}]*\}/);
    expect(networkRule).not.toBeNull();
    expect(networkRule![0]).not.toMatch(/overflow-y:\s*(auto|scroll)/);
  });
});
