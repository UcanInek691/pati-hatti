import { describe, expect, it } from "vitest";
import { getHealth } from "../src/health";

describe("getHealth", () => {
  it("returns ok status with a version and timestamp", () => {
    const result = getHealth();
    expect(result.status).toBe("ok");
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(() => new Date(result.timestamp)).not.toThrow();
  });
});
