import { describe, expect, it } from "vitest";
import { isWhatsAppCredentialRegistryValid, resolveWhatsAppAccessToken } from "../src/whatsappCredentials";

const accountA = "11111111-1111-1111-1111-111111111111";
const accountB = "22222222-2222-2222-2222-222222222222";

function entry(overrides: Partial<{ whatsapp_account_id: unknown; phone_number_id: unknown; access_token: unknown }> = {}) {
  return {
    whatsapp_account_id: accountA,
    phone_number_id: "918000001",
    access_token: "token-abc123",
    ...overrides,
  };
}

describe("isWhatsAppCredentialRegistryValid", () => {
  it("accepts a single well-formed entry", () => {
    expect(isWhatsAppCredentialRegistryValid(JSON.stringify([entry()]))).toBe(true);
  });

  it("accepts exactly ten entries", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      whatsapp_account_id: `${i}1111111-1111-1111-1111-111111111111`,
      phone_number_id: `91800000${i}`,
      access_token: `token-${i}`,
    }));
    expect(isWhatsAppCredentialRegistryValid(JSON.stringify(entries))).toBe(true);
  });

  it.each([
    ["not valid JSON", "not-json"],
    ["a JSON object, not an array", JSON.stringify({ ...entry() })],
    ["a JSON string", JSON.stringify("just a string")],
    ["a JSON number", JSON.stringify(1)],
    ["a JSON null", "null"],
    ["an empty array", "[]"],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, raw) => {
    expect(isWhatsAppCredentialRegistryValid(raw)).toBe(false);
  });

  it("rejects more than ten entries", () => {
    const accountPrefixes = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a"];
    const entries = accountPrefixes.map((prefix, i) => ({
      whatsapp_account_id: `${prefix}1111111-1111-1111-1111-111111111111`,
      phone_number_id: `91800000${i}`,
      access_token: `token-${i}`,
    }));
    expect(isWhatsAppCredentialRegistryValid(JSON.stringify(entries))).toBe(false);
  });

  it("rejects a registry exceeding the byte budget", () => {
    const raw = JSON.stringify([entry({ access_token: "a".repeat(4_990) })]);
    expect(raw.length).toBeGreaterThan(5_000);
    expect(isWhatsAppCredentialRegistryValid(raw)).toBe(false);
  });

  it.each([
    ["a non-object entry (array)", [[]]],
    ["a non-object entry (string)", ["not-an-object"]],
    ["a non-object entry (null)", [null]],
    ["an entry missing a key", [{ whatsapp_account_id: accountA, phone_number_id: "918000001" }]],
    ["an entry with an extra key", [{ ...entry(), extra: "x" }]],
    ["a non-string whatsapp_account_id", [entry({ whatsapp_account_id: 1 })]],
    ["an uppercase whatsapp_account_id", [entry({ whatsapp_account_id: "11111111-1111-1111-1111-11111111111a".toUpperCase() })]],
    ["a malformed whatsapp_account_id", [entry({ whatsapp_account_id: "not-a-uuid" })]],
    ["a non-string phone_number_id", [entry({ phone_number_id: 918000001 })]],
    ["an empty phone_number_id", [entry({ phone_number_id: "" })]],
    ["a non-numeric phone_number_id", [entry({ phone_number_id: "abc123" })]],
    ["an oversized phone_number_id", [entry({ phone_number_id: "1".repeat(65) })]],
    ["a non-string access_token", [entry({ access_token: 1 })]],
    ["an empty access_token", [entry({ access_token: "" })]],
    ["an access_token padded with whitespace", [entry({ access_token: "  token  " })]],
    ["an oversized access_token", [entry({ access_token: "a".repeat(1_025) })]],
    ["an access_token containing a C0 control character", [entry({ access_token: `token${String.fromCharCode(7)}abc` })]],
    ["an access_token containing DEL", [entry({ access_token: `token${String.fromCharCode(127)}abc` })]],
    ["an access_token containing a C1 control character", [entry({ access_token: `token${String.fromCharCode(133)}abc` })]],
    [
      "duplicate whatsapp_account_id across entries",
      [entry(), entry({ phone_number_id: "918000002" })],
    ],
    [
      "duplicate phone_number_id across entries",
      [entry(), entry({ whatsapp_account_id: accountB })],
    ],
  ])("rejects %s", (_label, entries) => {
    expect(isWhatsAppCredentialRegistryValid(JSON.stringify(entries))).toBe(false);
  });

  it("accepts an access_token at the maximum code point length", () => {
    expect(isWhatsAppCredentialRegistryValid(JSON.stringify([entry({ access_token: "a".repeat(1_024) })]))).toBe(true);
  });

  it("measures the registry ceiling in UTF-8 bytes, not JavaScript code units", () => {
    const raw = JSON.stringify([
      entry({ access_token: "ş".repeat(800) }),
      entry({ whatsapp_account_id: accountB, phone_number_id: "918000002", access_token: "ş".repeat(800) }),
      entry({ whatsapp_account_id: "33333333-3333-3333-3333-333333333333", phone_number_id: "918000003", access_token: "ş".repeat(800) }),
    ]);
    expect(raw.length).toBeLessThan(5_000);
    expect(new TextEncoder().encode(raw).length).toBeGreaterThan(5_000);
    expect(isWhatsAppCredentialRegistryValid(raw)).toBe(false);
  });
});

describe("resolveWhatsAppAccessToken", () => {
  const registry = JSON.stringify([
    { whatsapp_account_id: accountA, phone_number_id: "918000001", access_token: "token-a" },
    { whatsapp_account_id: accountB, phone_number_id: "918000002", access_token: "token-b" },
  ]);

  it("resolves the exact token for a matching account and phone number id", () => {
    expect(resolveWhatsAppAccessToken(registry, accountA, "918000001")).toEqual({ kind: "resolved", accessToken: "token-a" });
    expect(resolveWhatsAppAccessToken(registry, accountB, "918000002")).toEqual({ kind: "resolved", accessToken: "token-b" });
  });

  it("resolves exact pairs independently of registry order", () => {
    const reversed = JSON.stringify(JSON.parse(registry).reverse());
    expect(resolveWhatsAppAccessToken(reversed, accountA, "918000001")).toEqual({ kind: "resolved", accessToken: "token-a" });
    expect(resolveWhatsAppAccessToken(reversed, accountB, "918000002")).toEqual({ kind: "resolved", accessToken: "token-b" });
  });

  it("fails closed for a known account paired with the wrong phone number id", () => {
    expect(resolveWhatsAppAccessToken(registry, accountA, "918000002")).toEqual({ kind: "not_found" });
  });

  it("fails closed for an unknown account id", () => {
    expect(resolveWhatsAppAccessToken(registry, "99999999-9999-9999-9999-999999999999", "918000001")).toEqual({ kind: "not_found" });
  });

  it("fails closed when the registry itself is malformed", () => {
    expect(resolveWhatsAppAccessToken("not-json", accountA, "918000001")).toEqual({ kind: "not_found" });
    expect(resolveWhatsAppAccessToken("", accountA, "918000001")).toEqual({ kind: "not_found" });
  });

  it("rejects the whole registry when a later entry is malformed", () => {
    const partiallyValid = JSON.stringify([
      { whatsapp_account_id: accountA, phone_number_id: "918000001", access_token: "token-a" },
      { whatsapp_account_id: accountB, phone_number_id: "not-digits", access_token: "token-b" },
    ]);
    expect(resolveWhatsAppAccessToken(partiallyValid, accountA, "918000001")).toEqual({ kind: "not_found" });
  });
});
