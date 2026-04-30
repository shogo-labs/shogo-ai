/**
 * Minimal standalone filesystem server for the Shogo IDE prototype.
 * Exposes /api/fs/* routes scoped to the repo root (two levels up).
 * Run with:  bun run server
 */

import { promises as fs } from "node:fs";
import path from "node:path";

const PORT = Number(process.env.IDE_SERVER_PORT ?? 38325);
const WORKSPACE_ROOT = path.resolve(process.cwd(), "..", "..");

const DENY_DIRS = new Set([".git", ".shogo", "node_modules", ".vite", "dist", ".next", ".turbo"]);
const DENY_FILES = new Set([".env", ".env.local", ".env.production"]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt",
  ".yml", ".yaml", ".toml", ".css", ".scss", ".html", ".svg", ".prisma",
  ".py", ".rs", ".go", ".java", ".rb", ".sh",
]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".md": "markdown", ".mdx": "markdown",
  ".css": "css", ".scss": "scss", ".html": "html",
  ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
  ".py": "python", ".rs": "rust", ".go": "go",
  ".java": "java", ".rb": "ruby", ".sh": "shell",
  ".prisma": "prisma", ".svg": "xml",
};

function safeResolve(rel: string): string {
  const cleaned = (rel ?? "").replace(/^\/+/, "");
  const abs = path.resolve(WORKSPACE_ROOT, cleaned);
  if (abs !== WORKSPACE_ROOT && !abs.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error("Path escapes workspace root");
  }
  return abs;
}

const langOf = (name: string) => LANG_BY_EXT[path.extname(name).toLowerCase()] ?? "plaintext";

function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (!ext) return /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG)/i.test(name);
  return TEXT_EXT.has(ext);
}

interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: TreeNode[];
  language?: string;
}

async function readTree(abs: string, rel: string, depth: number): Promise<TreeNode[]> {
  if (depth <= 0) return [];
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".gitignore") continue;
    const isDir = e.isDirectory();
    if (isDir && DENY_DIRS.has(e.name)) continue;
    if (!isDir && DENY_FILES.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childAbs = path.join(abs, e.name);
    if (isDir) {
      nodes.push({ name: e.name, path: childRel, kind: "dir", children: await readTree(childAbs, childRel, depth - 1) });
    } else {
      nodes.push({ name: e.name, path: childRel, kind: "file", language: langOf(e.name) });
    }
  }
  nodes.sort((a, b) => (a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name)));
  return nodes;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return json({}, 204);
  const url = new URL(req.url);
  const { pathname, searchParams } = url;

  try {
    if (req.method === "GET" && pathname === "/api/fs/tree") {
      const rel = searchParams.get("path") ?? "";
      const depth = Math.min(parseInt(searchParams.get("depth") ?? "4", 10) || 4, 8);
      const abs = safeResolve(rel);
      const stat = await fs.stat(abs);
      if (!stat.isDirectory()) return json({ error: "Not a directory" }, 400);
      return json({ root: rel || "/", tree: await readTree(abs, rel, depth) });
    }

    if (req.method === "GET" && pathname === "/api/fs/file") {
      const rel = searchParams.get("path") ?? "";
      if (!rel) return json({ error: "path required" }, 400);
      const abs = safeResolve(rel);
      const name = path.basename(abs);
      if (DENY_FILES.has(name)) return json({ error: "Denied" }, 403);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) return json({ error: "Not a file" }, 400);
      if (stat.size > 2 * 1024 * 1024) return json({ error: "File too large (>2MB)" }, 413);
      if (!isTextFile(name)) return json({ error: "Binary file not supported" }, 415);
      const content = await fs.readFile(abs, "utf8");
      return json({ path: rel, name, language: langOf(name), size: stat.size, mtime: stat.mtimeMs, content });
    }

    if (req.method === "PUT" && pathname === "/api/fs/file") {
      const body = (await req.json().catch(() => null)) as { path?: string; content?: string } | null;
      if (!body?.path || typeof body.content !== "string") return json({ error: "path and content required" }, 400);
      const abs = safeResolve(body.path);
      const name = path.basename(abs);
      if (DENY_FILES.has(name)) return json({ error: "Denied" }, 403);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body.content, "utf8");
      const stat = await fs.stat(abs);
      return json({ ok: true, path: body.path, size: stat.size, mtime: stat.mtimeMs });
    }

    if (req.method === "POST" && pathname === "/api/fs/mkdir") {
      const body = (await req.json().catch(() => null)) as { path?: string } | null;
      if (!body?.path) return json({ error: "path required" }, 400);
      await fs.mkdir(safeResolve(body.path), { recursive: true });
      return json({ ok: true, path: body.path });
    }

    if (req.method === "DELETE" && pathname === "/api/fs/entry") {
      const rel = searchParams.get("path") ?? "";
      if (!rel) return json({ error: "path required" }, 400);
      const abs = safeResolve(rel);
      if (abs === WORKSPACE_ROOT) return json({ error: "Cannot delete root" }, 400);
      const name = path.basename(abs);
      if (DENY_DIRS.has(name) || DENY_FILES.has(name)) return json({ error: "Denied" }, 403);
      await fs.rm(abs, { recursive: true, force: true });
      return json({ ok: true, path: rel });
    }

    if (req.method === "POST" && pathname === "/api/fs/rename") {
      const body = (await req.json().catch(() => null)) as { from?: string; to?: string } | null;
      if (!body?.from || !body?.to) return json({ error: "from and to required" }, 400);
      const absFrom = safeResolve(body.from);
      const absTo = safeResolve(body.to);
      await fs.mkdir(path.dirname(absTo), { recursive: true });
      await fs.rename(absFrom, absTo);
      return json({ ok: true, from: body.from, to: body.to });
    }

    if (req.method === "POST" && pathname === "/api/agent/action") {
      const body = (await req.json().catch(() => null)) as AgentActionRequest | null;
      if (!body?.action || !body?.path) return json({ error: "action and path required" }, 400);
      try {
        const result = await runStubAgentAction(body);
        if (!result) return new Response(null, { status: 204 });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    if (pathname === "/api/health") return json({ ok: true, root: WORKSPACE_ROOT });
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}


// ─── Agent quick-actions ─────────────────────────────────────────────────────
//
// Deterministic stubs so the full UI loop (Explain / Refactor / +Tests) works
// without an LLM provider configured. To plug in a real agent (OpenAI, Anthropic,
// Ollama, etc.), replace `generateAgentResponse` below — every action funnels
// through it.
//
// The shape of `AgentActionResult` matches the client in
// src/components/ide/agent/agentActions.ts. Don't drift the two.

interface AgentActionRequest {
  action: "explain" | "refactor" | "tests";
  path: string;
  content: string;
  language?: string;
}

interface AgentActionResult {
  kind: "text" | "file";
  body?: string;
  path?: string;
  after?: string;
  rationale?: string;
}

/**
 * Single LLM swap point. Today this dispatches to deterministic stubs so the
 * UI flow can be exercised end-to-end without an API key. Replace the body
 * with a call to your provider of choice when ready, e.g.:
 *
 *   const provider = process.env.SHOGO_AGENT_PROVIDER ?? "stub";
 *   if (provider === "openai") return await callOpenAI(prompt);
 *   if (provider === "anthropic") return await callAnthropic(prompt);
 */
async function runStubAgentAction(req: AgentActionRequest): Promise<AgentActionResult | null> {
  switch (req.action) {
    case "explain":
      return { kind: "text", body: stubExplain(req) };
    case "refactor": {
      const after = stubRefactor(req.content);
      if (after === req.content) return null; // 204 → "No changes to propose"
      return {
        kind: "file",
        path: req.path,
        after,
        rationale: "Sorted imports + collapsed blank lines (stub refactor)",
      };
    }
    case "tests": {
      const result = stubTests(req);
      if (!result) return null;
      return { kind: "file", path: result.path, after: result.after, rationale: "Generated Vitest skeleton (stub)" };
    }
    default:
      throw new Error(`Unknown action: ${(req as { action: string }).action}`);
  }
}

function stubExplain(req: AgentActionRequest): string {
  const lines = req.content.split("\n");
  const ext = path.extname(req.path).toLowerCase();
  const lang = req.language ?? langOf(path.basename(req.path));
  const importMatches = req.content.match(/^\s*import\s.+from\s+['"][^'"]+['"]/gm) ?? [];
  const importNames = importMatches
    .map((l) => l.match(/from\s+['"]([^'"]+)['"]/)?.[1])
    .filter((x): x is string => Boolean(x));
  const namedExports = (req.content.match(/^export\s+(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/gm) ?? [])
    .map((l) => l.match(/(\w+)$/)?.[1])
    .filter((x): x is string => Boolean(x));
  const hasDefault = /^export\s+default\b/m.test(req.content);
  const jsxReturns = ext === ".tsx" || ext === ".jsx"
    ? (req.content.match(/return\s*\(\s*</g) ?? []).length
    : 0;

  const parts: string[] = [];
  parts.push(`**${path.basename(req.path)}** — ${lines.length} lines of ${lang}.`);

  const expSummary: string[] = [];
  if (hasDefault) expSummary.push("1 default export");
  if (namedExports.length) expSummary.push(`${namedExports.length} named export${namedExports.length === 1 ? "" : "s"} (${namedExports.slice(0, 5).join(", ")}${namedExports.length > 5 ? ", …" : ""})`);
  if (expSummary.length === 0) expSummary.push("no exports detected");
  parts.push(`Exports: ${expSummary.join(", ")}.`);

  if (importNames.length) {
    const preview = importNames.slice(0, 5).join(", ");
    const tail = importNames.length > 5 ? ", …" : "";
    parts.push(`Imports ${importNames.length} module${importNames.length === 1 ? "" : "s"}: ${preview}${tail}.`);
  } else {
    parts.push("No imports.");
  }

  if (jsxReturns > 0) {
    parts.push(`Contains ${jsxReturns} JSX return block${jsxReturns === 1 ? "" : "s"} — likely a presentational React component.`);
  } else if (ext === ".ts" || ext === ".tsx") {
    parts.push("Likely role: utility / logic module (no JSX returns).");
  }

  parts.push("");
  parts.push("_(stub explanation — replace `generateAgentResponse` in server.ts to wire a real LLM)_");
  return parts.join("\n\n");
}

/**
 * Sorts imports alphabetically and collapses runs of 2+ blank lines into one.
 * Pure-syntax transforms — produces a visible diff so the proposal flow is
 * exercisable.
 */
function stubRefactor(content: string): string {
  const lines = content.split("\n");
  // Find the contiguous import block at the top (after any leading shebang / comments).
  let start = 0;
  while (start < lines.length && /^\s*(\/\/|#!|\/\*|\*)/.test(lines[start])) start++;
  let end = start;
  const imports: string[] = [];
  while (end < lines.length) {
    const l = lines[end];
    if (/^\s*import\s.+from\s+['"][^'"]+['"];?\s*$/.test(l) || /^\s*import\s+['"][^'"]+['"];?\s*$/.test(l)) {
      imports.push(l);
      end++;
    } else if (l.trim() === "" && imports.length > 0 && end + 1 < lines.length && /^\s*import\s/.test(lines[end + 1])) {
      // blank line between imports — drop it
      end++;
    } else {
      break;
    }
  }
  if (imports.length > 1) {
    imports.sort((a, b) => {
      const ma = a.match(/from\s+['"]([^'"]+)['"]/)?.[1] ?? a;
      const mb = b.match(/from\s+['"]([^'"]+)['"]/)?.[1] ?? b;
      // External packages (no ./) before relative
      const aRel = ma.startsWith(".");
      const bRel = mb.startsWith(".");
      if (aRel !== bRel) return aRel ? 1 : -1;
      return ma.localeCompare(mb);
    });
  }
  const head = lines.slice(0, start);
  const tail = lines.slice(end);
  const merged = [...head, ...imports, ...tail];

  // Collapse 3+ consecutive blank lines down to 1.
  const out: string[] = [];
  let blankRun = 0;
  for (const l of merged) {
    if (l.trim() === "") {
      blankRun++;
      if (blankRun <= 1) out.push(l);
    } else {
      blankRun = 0;
      out.push(l);
    }
  }
  return out.join("\n");
}

function stubTests(req: AgentActionRequest): { path: string; after: string } | null {
  const ext = path.extname(req.path).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) return null;
  const dir = path.dirname(req.path);
  const base = path.basename(req.path, ext);
  if (base.endsWith(".test") || base.endsWith(".spec")) return null;
  const testPath = (dir === "." ? "" : `${dir}/`) + `${base}.test${ext}`;
  const importPath = `./${base}`;

  const named = (req.content.match(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/gm) ?? [])
    .map((l) => l.match(/(\w+)$/)?.[1])
    .filter((x): x is string => Boolean(x));
  const hasDefault = /^export\s+default\b/m.test(req.content);

  const importLine = (() => {
    const parts: string[] = [];
    if (hasDefault) parts.push(base);
    if (named.length) parts.push(`{ ${named.join(", ")} }`);
    if (parts.length === 0) return `import "${importPath}";`;
    return `import ${parts.join(", ")} from "${importPath}";`;
  })();

  const tests: string[] = [];
  if (hasDefault) {
    tests.push(`  it("${base} default export is defined", () => {\n    expect(${base}).toBeDefined();\n  });`);
  }
  for (const n of named) {
    tests.push(`  it("${n} is defined", () => {\n    expect(${n}).toBeDefined();\n  });`);
  }
  if (tests.length === 0) {
    tests.push(`  it("loads without throwing", () => {\n    expect(true).toBe(true);\n  });`);
  }

  const body = `import { describe, it, expect } from "vitest";
${importLine}

describe("${base}", () => {
${tests.join("\n\n")}
});
`;
  return { path: testPath, after: body };
}

// @ts-expect-error Bun global is available at runtime
Bun.serve({ port: PORT, fetch: handle });
console.log(`[ide-server] listening on http://localhost:${PORT}`);
console.log(`[ide-server] serving workspace root: ${WORKSPACE_ROOT}`);
