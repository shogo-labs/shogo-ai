import { describe, expect, test } from "bun:test";
import { generateWhatsNewCatalog, renderCatalog } from "../generate-whats-new";

describe("generate-whats-new", () => {
  test("converts opted-in release entries into the mobile catalog", () => {
    const catalog = generateWhatsNewCatalog();
    const release = catalog.find((item) => item.slug === "v1-12");

    expect(release).toMatchObject({
      version: "1.12",
      title: "Shogo 1.12",
      announce: true,
      url: "https://docs.shogo.ai/changelog/v1-12",
    });
    expect(release?.highlights).toHaveLength(5);
    expect(release?.intro).toContain("built-in code editor");
  });

  test("renders deterministic JSON with a trailing newline", () => {
    expect(renderCatalog([])).toBe("[]\n");
  });
});
