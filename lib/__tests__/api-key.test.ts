import { describe, it, expect } from "vitest";
import { looksLikeApiKey, maskApiKey, API_KEY_HEADER } from "../api-key";

describe("looksLikeApiKey", () => {
  it("accepts a plausible Anthropic key", () => {
    expect(looksLikeApiKey("sk-ant-api03-abcdefghijklmnop")).toBe(true);
  });

  it("tolerates surrounding whitespace from a paste", () => {
    expect(looksLikeApiKey("  sk-ant-api03-abcdefghijklmnop\n")).toBe(true);
  });

  it("rejects keys from the wrong provider", () => {
    expect(looksLikeApiKey("sk-proj-abcdefghijklmnopqrst")).toBe(false);
  });

  it("rejects empty and truncated input", () => {
    expect(looksLikeApiKey("")).toBe(false);
    expect(looksLikeApiKey("sk-ant-")).toBe(false);
  });
});

describe("maskApiKey", () => {
  it("shows only the prefix and last four characters", () => {
    const masked = maskApiKey("sk-ant-api03-SECRETSECRETSECRET-wxyz");
    expect(masked).toBe("sk-ant-api0…wxyz");
  });

  it("never leaks the middle of the key", () => {
    const key = "sk-ant-api03-SECRETSECRETSECRET-wxyz";
    expect(maskApiKey(key)).not.toContain("SECRET");
    expect(maskApiKey(key).length).toBeLessThan(key.length);
  });

  it("fully masks a short string rather than revealing it", () => {
    expect(maskApiKey("sk-ant-")).toBe("•••••••");
  });
});

describe("transport", () => {
  it("sends the key in a header, not a body field", () => {
    // Headers keep the credential out of anything that logs request bodies.
    expect(API_KEY_HEADER).toBe("x-anthropic-api-key");
  });
});
