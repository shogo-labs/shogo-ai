// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Generate the mobile app's opt-in What's New catalog from the canonical
 * Docusaurus changelog entries.
 *
 * The generated JSON is committed because the mobile bundle must have a
 * deterministic catalog for native builds and OTA updates.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dir, "..");
const CHANGELOG_DIR = join(ROOT, "apps", "docs", "changelog");
const OUTPUT_PATH = join(
  ROOT,
  "apps",
  "mobile",
  "lib",
  "whats-new",
  "releases.generated.json",
);
const CHANGELOG_URL = "https://docs.shogo.ai/changelog";

export const SUPPORTED_ICONS = [
  "activity",
  "code",
  "layers",
  "rocket",
  "server",
  "sparkles",
] as const;

export type WhatsNewIcon = (typeof SUPPORTED_ICONS)[number];

export interface WhatsNewHighlight {
  title: string;
  description: string;
  icon?: WhatsNewIcon;
}

export interface WhatsNewRelease {
  version: string;
  slug: string;
  title: string;
  date: string;
  announce: boolean;
  intro: string;
  highlights: WhatsNewHighlight[];
  url: string;
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function parseEntry(fileName: string): WhatsNewRelease {
  const source = readFileSync(join(CHANGELOG_DIR, fileName), "utf8");
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) fail(fileName, "expected YAML front matter");

  const frontMatter = parse(match[1]) as Record<string, unknown>;
  const slug = String(frontMatter.slug ?? fileName.replace(/\.md$/, ""));
  const versionMatch = slug.match(/^v(\d+)-(\d+)$/i);
  if (!versionMatch) fail(fileName, `slug must look like v1-12, got ${slug}`);

  const date = String(frontMatter.date ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail(fileName, "date must be YYYY-MM-DD");
  }

  const announce = frontMatter.announce === true;
  const rawHighlights = frontMatter.highlights ?? [];
  if (!Array.isArray(rawHighlights)) {
    fail(fileName, "highlights must be an array");
  }

  const highlights = rawHighlights.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      fail(fileName, `highlights[${index}] must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const description =
      typeof item.description === "string" ? item.description.trim() : "";
    if (!title || !description) {
      fail(fileName, `highlights[${index}] needs title and description`);
    }
    const icon = item.icon == null ? undefined : String(item.icon);
    if (icon && !(SUPPORTED_ICONS as readonly string[]).includes(icon)) {
      fail(
        fileName,
        `highlights[${index}].icon "${icon}" is unsupported; use ${SUPPORTED_ICONS.join(", ")}`,
      );
    }
    return {
      title,
      description,
      ...(icon ? { icon: icon as WhatsNewIcon } : {}),
    };
  });

  if (announce && (highlights.length < 1 || highlights.length > 5)) {
    fail(fileName, "announced releases need between 1 and 5 highlights");
  }

  const intro = match[2]
    .split("<!-- truncate -->", 1)[0]
    .trim()
    .split(/\n\s*\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();

  return {
    version: `${versionMatch[1]}.${versionMatch[2]}`,
    slug,
    title: String(
      frontMatter.title ?? `Shogo ${versionMatch[1]}.${versionMatch[2]}`,
    ),
    date,
    announce,
    intro,
    highlights,
    url: `${CHANGELOG_URL}/${slug}`,
  };
}

export function generateWhatsNewCatalog(): WhatsNewRelease[] {
  return readdirSync(CHANGELOG_DIR)
    .filter((fileName) => /^\d{4}-\d{2}-\d{2}-v\d+-\d+\.md$/i.test(fileName))
    .map(parseEntry)
    .sort((a, b) => {
      const [aMajor, aMinor] = a.version.split(".").map(Number);
      const [bMajor, bMinor] = b.version.split(".").map(Number);
      return bMajor - aMajor || bMinor - aMinor;
    });
}

export function renderCatalog(catalog: WhatsNewRelease[]): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function main(): void {
  const catalog = generateWhatsNewCatalog();
  const output = renderCatalog(catalog);
  const check = process.argv.includes("--check");
  let current = "";
  try {
    current = readFileSync(OUTPUT_PATH, "utf8");
  } catch {
    // A missing generated file is stale and will be reported below.
  }

  if (check) {
    if (current !== output) {
      console.error(
        `What's New catalog is stale. Run bun scripts/generate-whats-new.ts.`,
      );
      process.exitCode = 1;
    }
    return;
  }

  writeFileSync(OUTPUT_PATH, output);
  console.log(`Wrote ${OUTPUT_PATH} (${catalog.length} release(s)).`);
}

if (import.meta.main) main();
