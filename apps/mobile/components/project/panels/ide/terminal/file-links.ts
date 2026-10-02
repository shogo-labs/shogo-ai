// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Clickable `path/to/file.ts:12:5` references in terminal output (compiler /
// test / stack-trace lines). Pure parsing here; the xterm link provider lives
// in xterm-session.ts and the Workbench opens the file.

export const OPEN_FILE_EVENT = "shogo:ide-open-file";

export interface OpenFileDetail {
  path: string;
  line: number;
  column: number;
}

export interface FileLinkMatch extends OpenFileDetail {
  /** 0-based start index in the line, and length of the matched text. */
  index: number;
  length: number;
  text: string;
}

// path chars, a dotted extension, then :line[:col] — also tolerates `(line,col)` TS style.
const RE = /((?:\.{1,2}\/|\/)?[\w@~+\-.]+(?:\/[\w@~+\-.]+)*\.[A-Za-z][\w]{0,7})(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\))/g;

export function findFileLinks(line: string): FileLinkMatch[] {
  const out: FileLinkMatch[] = [];
  RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(line))) {
    // Skip URLs (http://host.com:80/…): the regex may start at the 2nd slash of `://`.
    const prev = line[m.index - 1];
    if (prev === ":" || (m[1].startsWith("/") && prev === "/")) continue;
    if (m.index >= 2 && line.slice(m.index - 2, m.index) === "//") continue;
    const path = m[1].replace(/^\.\//, "");
    const ln = Number(m[2] ?? m[4]);
    const col = Number(m[3] ?? m[5] ?? 1);
    if (!Number.isFinite(ln) || ln < 1) continue;
    out.push({ path, line: ln, column: Math.max(1, col), index: m.index, length: m[0].length, text: m[0] });
  }
  return out;
}
