// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// `git blame --porcelain` parser.
//
// Porcelain format (per commit, then per blamed line):
//
//   <40-char-sha> <orig-line> <final-line> <num-lines>
//   author <name>
//   author-mail <email>
//   author-time <epoch-secs>
//   author-tz <tz>
//   committer …
//   summary <subject>
//   previous <sha> <path>     (optional)
//   filename <path>
//   \t<raw line content>      (the actual source line)
//
// Subsequent lines for the same commit only emit the header
//   <sha> <orig-line> <final-line>
// and then the \t<source> line — the metadata block is deduplicated.

import { runGit } from "./repository";

export interface BlameLine {
  /** 1-based line number in the current file. */
  line: number;
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  authorTime: number; // epoch seconds
  summary: string;
}

type BlameResult =
  | { ok: true; lines: BlameLine[] }
  | { ok: false; error: string };

export async function blameFile(root: string, relPath: string): Promise<BlameResult> {
  const res = await runGit(
    ["blame", "--porcelain", "--", relPath],
    { cwd: root, timeoutMs: 30_000 },
  );
  if (!res.ok) {
    if (/no such path/i.test(res.stderr) || /does not exist/i.test(res.stderr)) {
      return { ok: true, lines: [] };
    }
    return { ok: false, error: res.stderr.trim() || `git blame exit ${res.code}` };
  }
  return { ok: true, lines: parseBlame(res.stdout) };
}

/** Pure parser, exported for unit tests. */
export function parseBlame(stdout: string): BlameLine[] {
  const out: BlameLine[] = [];
  // We index commit metadata by SHA so subsequent lines from the same
  // commit can resolve their fields without re-parsing the header block.
  type CommitMeta = {
    author: string;
    authorEmail: string;
    authorTime: number;
    summary: string;
  };
  const commits = new Map<string, CommitMeta>();

  const lines = stdout.split("\n");
  let i = 0;
  let pendingSha: string | null = null;
  let pendingFinalLine: number | null = null;
  let pendingMeta: Partial<CommitMeta> = {};

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;

    // Header line: `<sha> <orig> <final> [num]`. Matches both first-of-commit
    // and subsequent (no metadata block follows).
    const headerMatch = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (headerMatch) {
      pendingSha = headerMatch[1];
      pendingFinalLine = Number.parseInt(headerMatch[2], 10);
      pendingMeta = {};
      i++;
      continue;
    }

    // Metadata fields.
    if (line.startsWith("author ")) {
      pendingMeta.author = line.slice("author ".length);
      i++;
      continue;
    }
    if (line.startsWith("author-mail ")) {
      pendingMeta.authorEmail = line.slice("author-mail ".length).replace(/^<|>$/g, "");
      i++;
      continue;
    }
    if (line.startsWith("author-time ")) {
      pendingMeta.authorTime = Number.parseInt(line.slice("author-time ".length), 10);
      i++;
      continue;
    }
    if (line.startsWith("summary ")) {
      pendingMeta.summary = line.slice("summary ".length);
      i++;
      continue;
    }
    if (line.startsWith("\t")) {
      // Body line — this is the actual source line. We emit the BlameLine
      // here, looking up metadata if we've seen the commit before.
      if (pendingSha !== null && pendingFinalLine !== null) {
        let meta = commits.get(pendingSha);
        if (!meta) {
          meta = {
            author: pendingMeta.author ?? "",
            authorEmail: pendingMeta.authorEmail ?? "",
            authorTime: pendingMeta.authorTime ?? 0,
            summary: pendingMeta.summary ?? "",
          };
          commits.set(pendingSha, meta);
        }
        out.push({
          line: pendingFinalLine,
          sha: pendingSha,
          shortSha: pendingSha.slice(0, 7),
          author: meta.author,
          authorEmail: meta.authorEmail,
          authorTime: meta.authorTime,
          summary: meta.summary,
        });
      }
      pendingSha = null;
      pendingFinalLine = null;
      pendingMeta = {};
      i++;
      continue;
    }
    // Other metadata we don't care about (boundary, previous, filename, etc.)
    i++;
  }
  return out;
}
