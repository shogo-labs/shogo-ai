// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Tiny glob matcher for the Search view's "files to include / exclude" boxes
// (VS Code syntax, comma separated): `*.ts, src/**, !dist` style without the
// bang. Patterns:
//   • `*.ts`, `*.{ts,tsx}`  – no slash → matches the basename at any depth
//   • `src/**/*.test.ts`    – with a slash → anchored to the workspace root
//   • `src`, `apps/web`     – a plain folder → that folder and everything in it
//   • `**`, `*`, `?`, `{a,b}` are supported; `/` is the only separator.

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

function globToSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories; a trailing `**` everything.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(",").map((a) => globToSource(a));
        out += `(?:${alts.join("|")})`;
        i = end;
      } else {
        out += "\\{";
      }
    } else {
      out += escapeRe(c);
    }
  }
  return out;
}

function compileOne(raw: string): ((path: string) => boolean) | null {
  let p = raw.trim().replace(/\\/g, "/");
  if (!p) return null;
  p = p.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!p) return null;
  const hasGlob = /[*?{]/.test(p);
  const hasSlash = p.includes("/");
  if (!hasGlob) {
    // Plain folder or file path.
    const anchored = p.replace(/^\//, "");
    if (hasSlash || p.startsWith("/")) {
      return (path) => path === anchored || path.startsWith(`${anchored}/`);
    }
    // Bare name: that file/folder at any depth.
    return (path) => path.split("/").includes(p);
  }
  const src = globToSource(p.replace(/^\//, ""));
  if (hasSlash) {
    const re = new RegExp(`^${src}(?:/.*)?$`);
    return (path) => re.test(path);
  }
  const re = new RegExp(`^${src}$`);
  return (path) => {
    const segs = path.split("/");
    // basename, or any folder segment (so `node_*` excludes the folder too)
    return segs.some((s) => re.test(s));
  };
}

/**
 * Compile a comma-separated pattern list. Returns null when the list is empty
 * (meaning "no constraint"). Braces keep their inner commas.
 */
export function compileGlobList(spec: string | undefined | null): ((path: string) => boolean) | null {
  if (!spec || !spec.trim()) return null;
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of spec) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  const matchers = parts.map(compileOne).filter((m): m is (path: string) => boolean => m !== null);
  if (matchers.length === 0) return null;
  return (path) => matchers.some((m) => m(path));
}

/** Combine include/exclude specs into a single predicate over workspace-relative paths. */
export function buildPathFilter(
  include: string | undefined | null,
  exclude: string | undefined | null,
): ((path: string) => boolean) | null {
  const inc = compileGlobList(include);
  const exc = compileGlobList(exclude);
  if (!inc && !exc) return null;
  return (path) => (!inc || inc(path)) && !(exc && exc(path));
}
