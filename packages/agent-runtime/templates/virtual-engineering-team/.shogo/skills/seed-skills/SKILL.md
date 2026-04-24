---
name: seed-skills
description: Seed the SkillDoc table with the 41 ported gstack SKILL.md files so the Roles and Skills Registry surfaces render correctly.
when_to_use: Run once on first boot, or any time port-gstack.ts has just been re-run and the SkillDoc table is out of date relative to .shogo/skills/gstack-*/SKILL.md.
---

# seed-skills

You are responsible for populating the `SkillDoc` table from the ported gstack
skill files on disk. This is a one-shot deterministic operation — no prompting
the model to generate prompts, no invention.

## Source of truth

- Files:   `.shogo/skills/gstack-*/SKILL.md` (each has a YAML frontmatter block
           followed by the verbatim upstream body)
- Manifest: `.shogo/skills/gstack-manifest.json` (produced by `scripts/port-gstack.ts`)

The manifest is the authoritative list. If a file on disk is missing from the
manifest, skip it and log a warning — it means the port is out of sync.

## What to do

For each entry in `gstack-manifest.json`:

1. Read the corresponding file
   `.shogo/skills/gstack-<entry.name>/SKILL.md`.
2. Parse off the leading YAML frontmatter block (everything from the first
   `---` through the matching closing `---` plus the single trailing blank
   line). The remaining text is the **verbatim body**.
3. Upsert a row into `SkillDoc` with:

   ```
   name       = entry.name                // e.g. "office-hours"
   role       = entry.role                // from the manifest
   stage      = entry.stage               // from the manifest
   sourceUrl  = entry.sourceUrl
   sourceSha  = entry.sourceSha
   body       = <verbatim body, no frontmatter>
   isCore     = entry.isCore
   portedAt   = entry.portedAt
   ```

   Use `POST /api/skill-docs` for a new row or `PATCH /api/skill-docs/:id` to
   update an existing one keyed by `name`.

4. After the loop, verify the count:
   `GET /api/skill-docs` should return exactly `manifest.skillCount` rows. If
   the count is off, surface a `WARN: skill seed count mismatch` line.

## Rules

- **Never rewrite the body.** The `body` column must be byte-identical to the
  upstream gstack `SKILL.md` at the pinned commit. If you feel the urge to
  reformat, stop — that is exactly the bug this whole template exists to
  avoid.
- **Never fabricate roles or stages.** Use the values from the manifest. If
  the manifest is missing or corrupt, refuse to seed and tell the user to
  re-run `scripts/port-gstack.ts`.
- This skill is idempotent: running it twice should leave the `SkillDoc`
  table in the same final state.

## Expected final output (markdown)

```
SEED: <N> skills seeded (<core> core, <optional> optional)
UPSTREAM: <commit>
MANIFEST: in sync with files
```
