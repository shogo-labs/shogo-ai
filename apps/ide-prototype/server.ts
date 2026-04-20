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

    if (pathname === "/api/health") return json({ ok: true, root: WORKSPACE_ROOT });
    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

// @ts-expect-error Bun global is available at runtime
Bun.serve({ port: PORT, fetch: handle });
console.log(`[ide-server] listening on http://localhost:${PORT}`);
console.log(`[ide-server] serving workspace root: ${WORKSPACE_ROOT}`);
