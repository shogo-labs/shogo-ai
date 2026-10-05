import { describe, expect, test } from "bun:test";
import { languageFor } from "../language";

describe("languageFor", () => {
  test("dotenv family is highlighted as ini, not plaintext", () => {
    for (const p of [".env", ".env.local", "apps/api/.env.production", ".env.example"]) {
      expect(languageFor(p)).toBe("ini");
    }
  });
  test("envelope.ts is not mistaken for an env file", () => {
    expect(languageFor("src/envelope.ts")).toBe("typescript");
    expect(languageFor("environment.md")).toBe("markdown");
  });
  test("common names and extensions", () => {
    expect(languageFor("tsconfig.json")).toBe("json");
    expect(languageFor("Dockerfile")).toBe("dockerfile");
    expect(languageFor("Makefile")).toBe("makefile");
    expect(languageFor("a/b/c.tsx")).toBe("typescript");
    expect(languageFor("LICENSE")).toBe("plaintext");
  });
});
