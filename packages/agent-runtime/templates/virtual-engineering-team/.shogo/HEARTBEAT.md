# Heartbeat Checklist — Virtual Engineering Team

## First-boot bootstrap (run before anything else)

- Read `.shogo/skills/gstack-manifest.json` and `GET /api/skill-docs`.
- If `items.length < manifest.skillCount` (or the endpoint returned empty because the table was never seeded), run the **`seed-skills`** skill once — it upserts every ported `.shogo/skills/gstack-*/SKILL.md` body into the `SkillDoc` table. Never try to reinvent this — `seed-skills` is idempotent and is the only thing that should write that table.
- Re-check `GET /api/skill-docs` and confirm the row count matches `manifest.skillCount`. If it still doesn't, surface a `WARN: skill seed count mismatch` line and stop — the Roles and Skills Registry surfaces will be empty otherwise.

## Every heartbeat

- Check for **active sprints** (`GET /api/sprints?status=active`) and surface the current stage for each on the Sprint Board.
- For any sprint in stage `think` with no Host artifact yet, spawn the **Host** sub-agent (verbatim `gstack-office-hours/SKILL.md`) with the sprint idea — produce the design doc and persist it as an `Artifact` row with `role=host, kind=design-doc`.
- For any sprint whose current stage has all its role artifacts present, surface a "ready to advance" indicator on the UI.

## Stage transitions (only on explicit advance)

Never auto-advance. A sprint moves to the next stage only when the founder clicks **Advance** on the Sprint Board, which calls `POST /api/sprints/:id/advance`. On each advance, spawn the roles for the new stage in parallel:

| Stage    | Roles spawned                                                                 |
|----------|-------------------------------------------------------------------------------|
| plan     | ceo, eng-mgr, designer (plan-ceo-review, plan-eng-review, plan-design-review) |
| build    | autoplan                                                                      |
| review   | reviewer, second-opinion (review, codex)                                      |
| test     | qa, investigate, cso                                                          |
| ship     | release, deploy (ship, land-and-deploy)                                       |
| reflect  | retro, memory (retro, learn)                                                  |

## Artifact hygiene

- Every sub-agent write creates an `Artifact` row with `sprintId`, `stage`, `role`, `kind`, `title`, `content` (markdown).
- Never delete artifacts; retros reference them.
- If a role returns no output, still persist an `Artifact` with `content: "(no findings)"` so the Sprint Board reflects that the role ran.

## Skill provenance

- Before spawning any role, read the corresponding `.shogo/skills/gstack-<skill>/SKILL.md`. The body **below the frontmatter** is the verbatim upstream gstack prompt and is the exact system prompt to pass.
- If a skill body has drifted from upstream (detect via `scripts/sync-gstack.ts`), flag it and do not spawn — surface a "port drift" warning.

## End of day

- Produce an EOD summary of active sprints: stage, latest artifact, blocked-on-role (if any).
- Archive sprints with `status=shipped` that have a final retro artifact.
