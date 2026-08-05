import { describe, expect, it } from "vitest";
import { verifyWhatsAppChallenge } from "../src/webhookVerify";

const TOKEN = "secret-token";

describe("verifyWhatsAppChallenge", () => {
  it("returns the challenge when mode and token match", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": TOKEN,
      "hub.challenge": "12345",
    });

    const result = verifyWhatsAppChallenge(params, TOKEN);
    expect(result).toEqual({ status: 200, body: "12345" });
  });

  it("rejects with 403 and never returns the challenge when the token is wrong", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "12345",
    });

    const result = verifyWhatsAppChallenge(params, TOKEN);
    expect(result.status).toBe(403);
    expect(result.body).not.toBe("12345");
  });

  it("rejects with 403 when mode is not subscribe", () => {
    const params = new URLSearchParams({
      "hub.mode": "unsubscribe",
      "hub.verify_token": TOKEN,
      "hub.challenge": "12345",
    });

    const result = verifyWhatsAppChallenge(params, TOKEN);
    expect(result.status).toBe(403);
  });

  it("returns 400 when required params are missing", () => {
    const params = new URLSearchParams({ "hub.mode": "subscribe" });
    const result = verifyWhatsAppChallenge(params, TOKEN);
    expect(result.status).toBe(400);
  });
});
