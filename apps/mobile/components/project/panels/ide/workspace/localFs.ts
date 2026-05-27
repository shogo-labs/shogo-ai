import { BINARY_FILE_EXTENSIONS } from "@shogo-ai/sdk/file-types";

import type {
  SearchOptions,
  SearchResponse,
  WorkspaceService,
  WsFile,
  WsNode,
} from "./types";

const DENY_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".vite",
  ".turbo",
  ".cache",
]);

/** Known-text extensions. We treat anything in this set as text without
 *  sniffing the bytes. The list is intentionally broad — log/csv/conf files
 *  are real source-tree citizens and Monaco renders them fine even without
 *  syntax highlighting. */
const TEXT_EXT = new Set([
  // JS / TS family
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  // Data / config
  "json", "json5", "jsonc", "yml", "yaml", "toml", "ini", "conf", "cfg",
  "properties", "env", "lock", "xml", "plist", "csv", "tsv", "tab", "ndjson",
  // Docs / prose
  "md", "mdx", "markdown", "txt", "rst", "adoc", "asciidoc", "log",
  // Web
  "css", "scss", "sass", "less", "html", "htm", "xhtml", "vue", "svelte",
  "astro",
  // Backend / systems
  "py", "pyi", "rs", "go", "java", "kt", "kts", "scala", "rb", "php",
  "swift", "c", "cc", "cpp", "cxx", "h", "hh", "hpp", "hxx", "m", "mm",
  "cs", "fs", "fsx", "fsi", "ml", "mli", "ex", "exs", "erl", "hrl", "clj",
  "cljs", "edn", "lua", "pl", "pm", "r", "jl", "dart", "nim", "zig", "v",
  "vb", "vbs", "ps1", "psm1", "ahk",
  // Shell / scripts
  "sh", "bash", "zsh", "fish", "ksh", "csh", "bat", "cmd",
  // Build / infra
  "gradle", "groovy", "make", "mk", "cmake", "bazel", "bzl", "buck", "ninja",
  "tf", "tfvars", "hcl", "nomad",
  // SQL / schemas
  "sql", "graphql", "gql", "prisma", "proto", "thrift", "avsc", "schema",
  // Vector / markup
  "svg",
  // Misc
  "diff", "patch", "gitignore", "gitattributes", "gitmodules",
  "dockerignore", "npmignore", "editorconfig", "prettierrc", "eslintrc",
  "babelrc", "nvmrc", "tool-versions",
]);

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", json5: "json", jsonc: "json", ndjson: "json",
  md: "markdown", mdx: "markdown", markdown: "markdown",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "html", htm: "html", xhtml: "html", vue: "html",
  svelte: "html", astro: "html",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", conf: "ini",
  cfg: "ini", properties: "ini", env: "shell",
  py: "python", pyi: "python",
  rs: "rust", go: "go",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  rb: "ruby", php: "php", swift: "swift",
  c: "c", cc: "cpp", cpp: "cpp", cxx: "cpp",
  h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  m: "objective-c", mm: "objective-c",
  cs: "csharp", fs: "fsharp", fsx: "fsharp", fsi: "fsharp",
  lua: "lua", pl: "perl", pm: "perl", r: "r", jl: "julia",
  dart: "dart", clj: "clojure", cljs: "clojure",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  ksh: "shell", csh: "shell", bat: "bat", cmd: "bat",
  ps1: "powershell", psm1: "powershell",
  sql: "sql", graphql: "graphql", gql: "graphql",
  prisma: "prisma", proto: "proto",
  xml: "xml", plist: "xml", svg: "xml",
  diff: "diff", patch: "diff",
  csv: "plaintext", tsv: "plaintext", tab: "plaintext", log: "plaintext",
  txt: "plaintext",
  tf: "hcl", tfvars: "hcl", hcl: "hcl",
  gradle: "groovy", groovy: "groovy",
  dockerfile: "dockerfile",
};

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function langOf(name: string) {
  return LANG[extOf(name)] ?? "plaintext";
}

/** Canonical binary-extension set lives in `@shogo-ai/core/file-types`
 *  (imported above). Used here as a fast reject before falling back to
 *  a content sniff for unknown extensions. */
const BINARY_EXT = BINARY_FILE_EXTENSIONS;

/** Classify a filename as text / binary by name alone.
 *  - `true`  : known text (extension allow-list, dotfiles, conventional
 *              no-extension files like README / Dockerfile / MEMORY).
 *  - `false` : known binary (extension deny-list).
 *  - `null`  : unknown — caller should fall back to a byte sniff.
 *  Callers MUST treat the three return values explicitly (use
 *  `=== true` / `=== false`), not truthy/falsy, so the unknown case is
 *  routed through the sniff rather than silently dropped. */
function isTextFile(name: string): boolean | null {
  // Treat common dotfiles as text (.env, .env.local, .gitignore, .prettierrc,
  // .editorconfig, .nvmrc, etc). The extension detector otherwise misclassifies
  // them because the leading dot makes "env"/"gitignore"/… look like an
  // unknown extension.
  if (name.startsWith(".")) return true;
  const e = extOf(name);
  if (!e) return /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG|AUTHORS|CONTRIBUTING|NOTICE|COPYING|TODO|HEARTBEAT|AGENTS|TOOLS|MEMORY)/i.test(name);
  if (TEXT_EXT.has(e)) return true;
  if (BINARY_EXT.has(e)) return false;
  return null;
}

/** Heuristic content sniff: returns true if the first 8KB of `file` looks
 *  like text (no NUL bytes, mostly printable / common-whitespace). Used for
 *  unknown extensions so we don't refuse to open a perfectly valid text
 *  file just because we never heard of its suffix. */
async function looksLikeText(file: File): Promise<boolean> {
  const slice = file.slice(0, 8192);
  const buf = new Uint8Array(await slice.arrayBuffer());
  if (buf.byteLength === 0) return true;
  let suspicious = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return false; // NUL → binary
    // Allow common whitespace + printable ASCII + high-bit (UTF-8 continuation).
    if (
      b === 0x09 || b === 0x0a || b === 0x0d ||
      (b >= 0x20 && b <= 0x7e) ||
      b >= 0x80
    ) continue;
    suspicious++;
  }
  return suspicious / buf.length < 0.1;
}

export function isFsaSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!isFsaSupported()) return null;
  try {
    return await (window as unknown as {
      showDirectoryPicker: (opts?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker({ mode: "readwrite" });
  } catch {
    return null;
  }
}

export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<boolean> {
  const h = handle as unknown as {
    queryPermission: (o: { mode: string }) => Promise<PermissionState>;
    requestPermission: (o: { mode: string }) => Promise<PermissionState>;
  };
  if ((await h.queryPermission({ mode })) === "granted") return true;
  return (await h.requestPermission({ mode })) === "granted";
}

/**
 * LocalFs — WorkspaceService backed by a File System Access API handle.
 * `path` is always relative to the directory handle. Empty string = root.
 */
export class LocalFs implements WorkspaceService {
  readonly id: string;
  readonly label: string;
  private root: FileSystemDirectoryHandle;

  constructor(id: string, label: string, handle: FileSystemDirectoryHandle) {
    this.id = id;
    this.label = label;
    this.root = handle;
  }

  private async resolve(path: string, opts?: { create?: boolean; dir?: boolean }) {
    if (!path) return { parent: this.root, name: "" as const };
    const parts = path.split("/").filter(Boolean);
    let cur: FileSystemDirectoryHandle = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = await cur.getDirectoryHandle(parts[i], { create: opts?.create });
    }
    return { parent: cur, name: parts[parts.length - 1] };
  }

  async listTree(path = "", depth = 4): Promise<WsNode[]> {
    const dir = path ? await this.getDir(path) : this.root;
    return this.readDir(dir, path, depth);
  }

  private async getDir(path: string): Promise<FileSystemDirectoryHandle> {
    const parts = path.split("/").filter(Boolean);
    let cur: FileSystemDirectoryHandle = this.root;
    for (const p of parts) cur = await cur.getDirectoryHandle(p);
    return cur;
  }

  private async readDir(
    dir: FileSystemDirectoryHandle,
    rel: string,
    depth: number,
  ): Promise<WsNode[]> {
    if (depth <= 0) return [];
    const nodes: WsNode[] = [];
    // @ts-expect-error async iterator available at runtime
    for await (const [name, entry] of dir.entries()) {
      const kind = entry.kind as "file" | "directory";
      // Hide noisy build/VCS dirs (see DENY_DIRS) but show regular dotfiles
      // like .env, .env.local, .prettierrc, etc — VS Code-style default.
      if (kind === "directory" && DENY_DIRS.has(name)) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      if (kind === "directory") {
        const sub = await this.readDir(
          entry as FileSystemDirectoryHandle,
          childRel,
          depth - 1,
        );
        nodes.push({ name, path: childRel, kind: "dir", children: sub });
      } else {
        nodes.push({ name, path: childRel, kind: "file", language: langOf(name) });
      }
    }
    nodes.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    return nodes;
  }

  async readFile(path: string): Promise<WsFile> {
    const { parent, name } = await this.resolve(path);
    if (!name) throw new Error("Invalid path");
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    // 10MB cap — generated route bundles and big logs routinely exceed 2MB
    // but Monaco copes well up to ~10MB. Beyond that the editor becomes
    // unresponsive, so we refuse with a friendly message.
    const MAX_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      throw new Error(
        `File too large to open in editor (${mb} MB, max 10 MB).`,
      );
    }
    // Three-step classification: extension allow-list, extension deny-list,
    // and finally a byte sniff for unknown extensions so .log, .csv, .dat,
    // and other "we don't know but it might be text" files still open.
    const known = isTextFile(name);
    if (known === false) {
      throw new Error(
        `\"${name}\" looks like a binary file and can't be opened in the text editor.`,
      );
    }
    if (known === null) {
      const sniff = await looksLikeText(file);
      if (!sniff) {
        throw new Error(
          `\"${name}\" looks like a binary file and can't be opened in the text editor.`,
        );
      }
    }
    const content = await file.text();
    return {
      path,
      name,
      language: langOf(name),
      size: file.size,
      mtime: file.lastModified,
      content,
    };
  }

  /** Read a file as a blob: URL — used by the image viewer for png/jpg/etc. */
  async readFileUrl(path: string): Promise<string> {
    const { parent, name } = await this.resolve(path);
    if (!name) throw new Error("Invalid path");
    const handle = await parent.getFileHandle(name);
    const file = await handle.getFile();
    return URL.createObjectURL(file);
  }

  async writeFile(path: string, content: string) {
    const { parent, name } = await this.resolve(path, { create: true });
    if (!name) throw new Error("Invalid path");
    const handle = await parent.getFileHandle(name, { create: true });
    const w = await handle.createWritable();
    await w.write(content);
    await w.close();
    const file = await handle.getFile();
    return { mtime: file.lastModified, size: file.size };
  }

  async mkdir(path: string) {
    const parts = path.split("/").filter(Boolean);
    let cur: FileSystemDirectoryHandle = this.root;
    for (const p of parts) {
      cur = await cur.getDirectoryHandle(p, { create: true });
    }
  }

  async remove(path: string) {
    const { parent, name } = await this.resolve(path);
    if (!name) throw new Error("Cannot remove root");
    await (parent as unknown as {
      removeEntry: (n: string, opts: { recursive: boolean }) => Promise<void>;
    }).removeEntry(name, { recursive: true });
  }

  async rename(from: string, to: string) {
    // FSA has no native rename; emulate via copy+delete.
    const fromInfo = await this.resolve(from);
    if (!fromInfo.name) throw new Error("Invalid source");
    // Detect file vs dir
    let isDir = false;
    try {
      await fromInfo.parent.getDirectoryHandle(fromInfo.name);
      isDir = true;
    } catch {
      /* file */
    }
    if (isDir) {
      await this.copyDir(from, to);
    } else {
      const file = await this.readFile(from);
      await this.writeFile(to, file.content);
    }
    await this.remove(from);
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
    if (!query) return { results: [], truncated: false };
    const limit = opts.limit ?? 200;
    const MAX_FILES = 1500;
    const MAX_PER_FILE = 20;

    let re: RegExp;
    try {
      re = opts.regex
        ? new RegExp(query, opts.caseSensitive ? "g" : "gi")
        : new RegExp(
            query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            opts.caseSensitive ? "g" : "gi",
          );
    } catch {
      throw new Error("Invalid regex");
    }

    const allFiles: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, rel: string) => {
      if (allFiles.length >= MAX_FILES) return;
      // @ts-expect-error async iterator at runtime
      for await (const [name, entry] of dir.entries()) {
        if (allFiles.length >= MAX_FILES) return;
        const childRel = rel ? `${rel}/${name}` : name;
        const kind = entry.kind as "file" | "directory";
        if (kind === "directory") {
          if (DENY_DIRS.has(name)) continue;
          await walk(entry as FileSystemDirectoryHandle, childRel);
        } else if (isTextFile(name) === true) {
          // Only index files we *know* are text. `null` (unknown extension)
          // is intentionally skipped here — the search walker can't pay the
          // per-file byte-sniff cost across an entire workspace, and a
          // false positive would silently grep through binary data.
          allFiles.push(childRel);
        }
      }
    };
    await walk(this.root, "");

    const results: SearchResponse["results"] = [];
    let total = 0;
    let truncated = allFiles.length >= MAX_FILES;

    for (const rel of allFiles) {
      if (total >= limit) { truncated = true; break; }
      let file: WsFile;
      try { file = await this.readFile(rel); } catch { continue; }
      const lines = file.content.split("\n");
      const matches: SearchResponse["results"][number]["matches"] = [];
      for (let i = 0; i < lines.length && matches.length < MAX_PER_FILE; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) {
          matches.push({
            line: i + 1,
            col: m.index + 1,
            preview: lines[i].length > 240 ? lines[i].slice(0, 240) : lines[i],
          });
          total++;
          if (total >= limit) break;
        }
      }
      if (matches.length) {
        results.push({ path: rel, language: file.language, matches });
      }
    }
    return { results, truncated };
  }

  private async copyDir(from: string, to: string) {
    await this.mkdir(to);
    const entries = await this.listTree(from, 16);
    for (const e of entries) {
      const rel = e.path.slice(from.length + 1);
      const target = `${to}/${rel}`;
      if (e.kind === "dir") await this.copyDir(e.path, target);
      else {
        const file = await this.readFile(e.path);
        await this.writeFile(target, file.content);
      }
    }
  }
}
