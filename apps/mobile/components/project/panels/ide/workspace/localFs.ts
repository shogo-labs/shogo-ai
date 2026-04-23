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

const TEXT_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "json", "md", "mdx", "txt", "yml", "yaml", "toml",
  "css", "scss", "html", "svg", "prisma",
  "py", "rs", "go", "java", "rb", "sh",
]);

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json",
  md: "markdown", mdx: "markdown",
  css: "css", scss: "scss", html: "html",
  yml: "yaml", yaml: "yaml", toml: "toml",
  py: "python", rs: "rust", go: "go",
  java: "java", rb: "ruby", sh: "shell",
  prisma: "prisma", svg: "xml",
};

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function langOf(name: string) {
  return LANG[extOf(name)] ?? "plaintext";
}

function isTextFile(name: string) {
  // Treat common dotfiles as text (.env, .env.local, .gitignore, .prettierrc,
  // .editorconfig, .nvmrc, etc). The extension detector otherwise misclassifies
  // them because the leading dot makes "env"/"gitignore"/… look like an
  // unknown extension.
  if (name.startsWith(".")) return true;
  const e = extOf(name);
  if (!e) return /^(Dockerfile|Makefile|README|LICENSE|CHANGELOG)/i.test(name);
  return TEXT_EXT.has(e);
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
    if (file.size > 2 * 1024 * 1024) throw new Error("File too large (>2MB)");
    if (!isTextFile(name)) throw new Error("Binary file not supported in this preview");
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
        } else if (isTextFile(name)) {
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
