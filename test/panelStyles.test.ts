import { describe, expect, it } from "vitest";
import { PANEL_STYLES, PANEL_STYLES_CSP_HASH } from "../src/panelStyles";

describe("PANEL_STYLES", () => {
  it("is a single native CSS string with no external resources", () => {
    expect(typeof PANEL_STYLES).toBe("string");
    expect(PANEL_STYLES).not.toMatch(/https?:\/\//);
    expect(PANEL_STYLES).not.toContain("@import");
    expect(PANEL_STYLES).not.toContain("url(");
  });

  it("preserves the pinned admin table/breakpoint substrings exactly", () => {
    expect(PANEL_STYLES).toContain("#overview-content { overflow-x: auto; }");
    expect(PANEL_STYLES).toContain("@media (max-width: 42rem)");
  });

  it("declares the accessibility and hierarchy rules Task 058 requires", () => {
    expect(PANEL_STYLES).toContain("[hidden] { display: none !important; }");
    expect(PANEL_STYLES).toContain(":focus-visible");
    expect(PANEL_STYLES).toContain("@media (prefers-reduced-motion: reduce)");
    expect(PANEL_STYLES).toContain(".btn-danger");
    expect(PANEL_STYLES).toContain("min-height: 2.75rem");
  });

  it("pins the exact inline-style CSP hash without unsafe-inline", async () => {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PANEL_STYLES));
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
    expect(PANEL_STYLES_CSP_HASH).toBe(`'sha256-${base64}'`);
    expect(PANEL_STYLES_CSP_HASH).not.toContain("unsafe-inline");
  });
});
