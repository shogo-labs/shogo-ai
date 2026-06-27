<!--
This file is intentionally prefixed with `_` so the Docusaurus blog plugin
ignores it (it is not a published changelog entry). See `exclude` defaults in
the blog plugin.
-->

# Changelog process

The user-facing changelog is published at https://docs.shogo.ai/changelog. It is
the Docusaurus blog plugin (configured in `apps/docs/docusaurus.config.ts`)
reading the markdown files in this directory.

## Rules

- **One entry per minor or major version** (e.g. `v1.12.0`, `v2.0.0`).
- **Patch releases are NOT published.** Everything shipped in patches
  (`v1.11.1` … `v1.11.24`) is rolled up into the next minor entry.
- Entries are **curated highlights**, written for users in benefit-oriented
  language — not a raw commit dump. Drop infra/CI/deploy/internal changes.

## How to add an entry when cutting a new minor/major

1. Draft a starting point from the commit log between the previous minor's `.0`
   tag and the new tag:

   ```bash
   bun scripts/draft-changelog.ts v1.13.0
   # or, for the newest tag with auto-detected range:
   bun scripts/draft-changelog.ts
   ```

   This writes `apps/docs/changelog/<date>-v1-13.md` with feat/fix commits
   grouped into **New** / **Fixed** (infra noise filtered out).

2. **Curate it.** Rewrite bullets in plain, user-facing language, lead with the
   biggest changes, group into `## New` / `## Improved` / `## Fixed`, and delete
   anything internal. Keep the `<!-- truncate -->` marker so the list page shows
   a clean excerpt.

3. Preview locally:

   ```bash
   bun run --cwd apps/docs dev      # then open /changelog
   ```

4. Commit the curated entry. It ships with the next docs deploy.

## File format

Each entry is a markdown file named `YYYY-MM-DD-vMAJOR-MINOR.md` with front
matter:

```md
---
slug: v1-12
title: Shogo 1.12
authors: [shogo-team]
tags: [release]
date: 2026-06-26
---

Short intro line shown as the excerpt.

<!-- truncate -->

## New
...
```

Authors are defined in `authors.yml`.
