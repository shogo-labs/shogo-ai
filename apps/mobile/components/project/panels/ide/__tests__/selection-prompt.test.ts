import { describe, expect, test } from "bun:test";
import { buildSelectionPrompt } from "../agentFixProvider";

describe("buildSelectionPrompt", () => {
  const base = { path: "src/a.ts", startLine: 3, endLine: 5, language: "typescript", text: "const x = 1" };
  test("includes location, fenced code and an instruction", () => {
    const p = buildSelectionPrompt({ ...base, kind: "explain" });
    expect(p).toContain("`src/a.ts`:3-5");
    expect(p).toContain("```typescript\nconst x = 1\n```");
    expect(p).toMatch(/Explain/);
  });
  test("single line has no range", () => {
    expect(buildSelectionPrompt({ ...base, endLine: 3, kind: "tests" })).toContain("`src/a.ts`:3:");
  });
  test("each kind asks for something different", () => {
    const kinds = (["explain", "improve", "tests"] as const).map((kind) => buildSelectionPrompt({ ...base, kind }));
    expect(new Set(kinds).size).toBe(3);
  });
});
