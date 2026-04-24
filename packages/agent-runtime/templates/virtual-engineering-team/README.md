# Virtual Engineering Team

A Shogo template that runs your product idea through a 7-stage sprint —
**Think → Plan → Build → Review → Test → Ship → Reflect** — using a cast of
role sub-agents whose system prompts are verbatim ports of the
[garrytan/gstack](https://github.com/garrytan/gstack) skills.

## Why this template is different

- **No invented prompts.** Every role's system prompt is the byte-identical
  `SKILL.md` file from gstack (MIT-licensed), pinned to commit
  `9e244c0bed0fa0ac1e7473e4ca3e6d73944d5634`. See `ATTRIBUTION.md`.
- **Real data, not mocks.** Surfaces fetch from an auto-generated Prisma +
  SQLite CRUD API. There are no `*.data.json` files. Open the Sprint Board
  and you are reading from a real DB.
- **Traceable.** The Skills Registry tab lists every ported skill with a
  clickable source link back to the pinned upstream file.

## Pipeline roles

| Stage    | Role            | Verbatim source                         |
|----------|-----------------|-----------------------------------------|
| Think    | Host            | `gstack/office-hours/SKILL.md`          |
| Plan     | CEO             | `gstack/plan-ceo-review/SKILL.md`       |
| Plan     | Eng Manager     | `gstack/plan-eng-review/SKILL.md`       |
| Plan     | Designer        | `gstack/plan-design-review/SKILL.md`    |
| Build    | Autoplan        | `gstack/autoplan/SKILL.md`              |
| Review   | Staff Eng       | `gstack/review/SKILL.md`                |
| Review   | Second Opinion  | `gstack/codex/SKILL.md`                 |
| Test     | QA Lead         | `gstack/qa/SKILL.md`                    |
| Test     | Debugger        | `gstack/investigate/SKILL.md`           |
| Test     | CSO             | `gstack/cso/SKILL.md`                   |
| Ship     | Release Eng     | `gstack/ship/SKILL.md`                  |
| Ship     | Deploy          | `gstack/land-and-deploy/SKILL.md`       |
| Reflect  | Retro           | `gstack/retro/SKILL.md`                 |
| Reflect  | Memory          | `gstack/learn/SKILL.md`                 |

27 additional gstack skills (design-shotgun, canary, benchmark, pair-agent,
freeze/guard/unfreeze/careful, document-release, …) are ported verbatim and
listed on the Skills Registry as "optional / power tool" — not wired into
the default pipeline.

## Re-port from upstream

```bash
git -C /tmp/gstack pull
bun run packages/agent-runtime/templates/virtual-engineering-team/scripts/port-gstack.ts \
  --gstack /tmp/gstack
```

Or check for drift without overwriting:

```bash
bun run packages/agent-runtime/templates/virtual-engineering-team/scripts/sync-gstack.ts \
  --gstack /tmp/gstack
```

## Data model

See `prisma/schema.prisma`. Three models:

- `Sprint` — one per idea; tracks current `stage` and `status`
- `Artifact` — every output a role produces (design-doc, review, qa-report, …) tied to a sprint + stage + role
- `SkillDoc` — verbatim mirror of every ported `SKILL.md`, served via `/api/skill-docs` for the Roles tab and Skills Registry

The auto-generated Hono CRUD routes are mounted at `/api/<kebab-plural>`.
Surfaces fetch through the typed client in `src/lib/vet-api.ts`.
