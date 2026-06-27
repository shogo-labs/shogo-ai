// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Draft a user-facing changelog entry for a MINOR or MAJOR release.
 *
 * Why this exists
 * ---------------
 * We publish a curated changelog to users at https://docs.shogo.ai/changelog
 * (the Docusaurus blog plugin reading `apps/docs/changelog/`). We deliberately
 * publish ONE entry per minor/major version (e.g. v1.12.0) and roll every
 * patch (v1.11.1 ... v1.11.24) up into the next minor — users don't get a
 * post for each patch.
 *
 * Hand-writing those summaries from 200+ commits is tedious, so this script
 * drafts a starting point: it diffs the commit log between the previous
 * minor's `.0` tag and the target tag, keeps the user-facing `feat:`/`fix:`
 * commits (dropping infra/CI/deploy noise), groups them into New / Fixed, and
 * writes a dated markdown file with the right Docusaurus front matter.
 *
 * The output is a DRAFT. A human must curate it before it ships: rewrite the
 * bullets in user-benefit language, drop anything internal, and move the most
 * important items to the top. See `apps/docs/changelog/README.md`.
 *
 * Usage
 * -----
 *   bun scripts/draft-changelog.ts                 # newest tag, auto-detect range
 *   bun scripts/draft-changelog.ts v1.12.0         # explicit target tag
 *   bun scripts/draft-changelog.ts v1.12.0 v1.11.0 # explicit target + previous
 *   bun scripts/draft-changelog.ts --stdout        # print to stdout, don't write
 */

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CHANGELOG_DIR = join(
  import.meta.dir ?? __dirname,
  "..",
  "apps",
  "docs",
  "changelog",
);

// Conventional-commit scopes/types that are plumbing, not user-facing. We drop
// these from the draft so the curator starts from signal, not noise.
const NOISE_SCOPE = new RegExp(
  [
    "ci",
    "deploy",
    "terraform",
    "k8s",
    "warm-pool",
    "sentry",
    "infra",
    "release",
    "build",
    "test",
    "chore",
    "docs",
    "eval-vm",
  ].join("|"),
);

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** All `vMAJOR.MINOR.PATCH` tags, newest first. */
function versionTags(): string[] {
  return git("tag", "--sort=-v:refname")
    .split("\n")
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
}

function parse(tag: string): { major: number; minor: number; patch: number } {
  const [major, minor, patch] = tag.slice(1).split(".").map(Number);
  return { major, minor, patch };
}

/**
 * The `.0` tag of the previous minor line. For v1.12.x that's v1.11.0; for the
 * first minor of a new major it's the previous major's first available `.0`.
 */
function previousMinorBaseTag(target: string, tags: string[]): string | null {
  const t = parse(target);
  const candidates = tags
    .map(parse)
    .filter((c) => c.major < t.major || (c.major === t.major && c.minor < t.minor))
    .sort((a, b) => b.major - a.major || b.minor - a.minor);
  if (candidates.length === 0) return null;
  // Prefer the `.0` of the immediately-preceding minor.
  const prev = candidates[0];
  const dotZero = `v${prev.major}.${prev.minor}.0`;
  return tags.includes(dotZero) ? dotZero : `v${prev.major}.${prev.minor}.${prev.patch}`;
}

type Commit = { type: string; scope: string | null; subject: string };

function parseCommit(line: string): Commit | null {
  // Matches: feat(scope): subject  |  fix: subject
  const m = line.match(/^(feat|fix)(?:\(([^)]+)\))?(!)?:\s*(.+)$/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), scope: m[2] ?? null, subject: m[4].trim() };
}

function isNoise(c: Commit): boolean {
  return c.scope != null && NOISE_SCOPE.test(c.scope);
}

function titleCase(subject: string): string {
  return subject.charAt(0).toUpperCase() + subject.slice(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const toStdout = argv.includes("--stdout");
  const positional = argv.filter((a) => !a.startsWith("--"));

  const tags = versionTags();
  if (tags.length === 0) {
    console.error("No vX.Y.Z tags found.");
    process.exit(1);
  }

  const target = positional[0] ?? tags[0];
  if (!tags.includes(target)) {
    console.error(`Tag ${target} not found. Available: ${tags.slice(0, 5).join(", ")} ...`);
    process.exit(1);
  }

  const t = parse(target);
  if (t.patch !== 0) {
    console.warn(
      `Warning: ${target} is a patch release. We publish changelog entries only ` +
        `for minor/major versions (x.y.0). Continuing anyway so you can preview.`,
    );
  }

  const base = positional[1] ?? previousMinorBaseTag(target, tags);
  const range = base ? `${base}..${target}` : target;

  const subjects = git("log", "--no-merges", "--pretty=%s", range)
    .split("\n")
    .filter(Boolean);

  const features: Commit[] = [];
  const fixes: Commit[] = [];
  for (const line of subjects) {
    const c = parseCommit(line);
    if (!c || isNoise(c)) continue;
    (c.type === "feat" ? features : fixes).push(c);
  }

  const date = git("log", "-1", "--format=%cs", target); // YYYY-MM-DD
  const slug = `v${t.major}-${t.minor}`;
  const title = `Shogo ${t.major}.${t.minor}`;

  const bullet = (c: Commit) =>
    `- ${titleCase(c.subject)}${c.scope ? ` _(${c.scope})_` : ""}`;

  const lines: string[] = [
    "---",
    `slug: ${slug}`,
    `title: ${title}`,
    "authors: [shogo-team]",
    "tags: [release]",
    `date: ${date}`,
    "---",
    "",
    `<!-- DRAFT — curate before publishing. Rewrite bullets in user-benefit `,
    `language, drop anything internal, and lead with the biggest items. -->`,
    "",
    `_Summary of changes since ${base ?? "the previous release"}._`,
    "",
    "<!-- truncate -->",
    "",
    "## New",
    "",
    ...(features.length ? features.map(bullet) : ["- _(none)_"]),
    "",
    "## Fixed",
    "",
    ...(fixes.length ? fixes.map(bullet) : ["- _(none)_"]),
    "",
  ];
  const content = lines.join("\n");

  if (toStdout) {
    process.stdout.write(content);
    return;
  }

  const outPath = join(CHANGELOG_DIR, `${date}-${slug}.md`);
  if (existsSync(outPath)) {
    console.error(
      `Refusing to overwrite existing ${outPath}. Edit it directly, or use --stdout.`,
    );
    process.exit(1);
  }
  writeFileSync(outPath, content);
  console.log(`Wrote draft: ${outPath}`);
  console.log(
    `Range ${range}: ${features.length} feature(s), ${fixes.length} fix(es) after dropping noise.`,
  );
  console.log("Curate it, then commit. Patch releases are intentionally rolled up.");
}

main();
