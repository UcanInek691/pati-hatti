import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readRawBodyWithLimit, verifyHmacSignature } from "../src/webhookSignature";
import { signHmacSha256 } from "./signHelper";

const SECRET = "test-app-secret";
const BODY = '{"object":"whatsapp_business_account","entry":[]}';

describe("verifyHmacSignature", () => {
  it("accepts a correctly computed signature", async () => {
    const header = await signHmacSha256(SECRET, BODY);
    const valid = await verifyHmacSignature(new TextEncoder().encode(BODY), header, SECRET);
    expect(valid).toBe(true);
  });

  it("rejects when the header is missing", async () => {
    const valid = await verifyHmacSignature(new TextEncoder().encode(BODY), null, SECRET);
    expect(valid).toBe(false);
  });

  it("fails closed when the app secret is empty", async () => {
    const header = await signHmacSha256(SECRET, BODY);
    const valid = await verifyHmacSignature(new TextEncoder().encode(BODY), header, "");
    expect(valid).toBe(false);
  });

  it("rejects a wrong signature", async () => {
    const header = await signHmacSha256("a-different-secret", BODY);
    const valid = await verifyHmacSignature(new TextEncoder().encode(BODY), header, SECRET);
    expect(valid).toBe(false);
  });

  it("rejects malformed hex characters", async () => {
    const header = `sha256=${"zz".repeat(32)}`;
    const valid = await verifyHmacSignature(new TextEncoder().encode(BODY), header, SECRET);
    expect(valid).toBe(false);
  });

  it("rejects a digest of the wrong length", async () => {
    const header = `sha256=${"ab".repeat(31)}`;
    const valid = await verifyHmacSignature(new TextEncoder().encode(BODY), header, SECRET);
    expect(valid).toBe(false);
  });

  it("rejects a header missing the sha256= prefix", async () => {
    const digest = (await signHmacSha256(SECRET, BODY)).replace("sha256=", "");
    const valid = await verifyHmacSignature(new TextEncoder().encode(BODY), digest, SECRET);
    expect(valid).toBe(false);
  });
});

describe("readRawBodyWithLimit", () => {
  it("returns the exact bytes for a body within the limit", async () => {
    const req = new Request("https://vetai.test/", { method: "POST", body: BODY });
    const bytes = await readRawBodyWithLimit(req, MAX_BODY_BYTES);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(BODY);
  });

  it("returns null once the byte count exceeds the limit, regardless of Content-Length", async () => {
    const oversized = "a".repeat(MAX_BODY_BYTES + 1);
    const req = new Request("https://vetai.test/", {
      method: "POST",
      body: oversized,
      headers: { "content-length": "1" },
    });
    const bytes = await readRawBodyWithLimit(req, MAX_BODY_BYTES);
    expect(bytes).toBeNull();
  });
});
