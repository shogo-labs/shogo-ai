# Heartbeat Tasks

## Every Heartbeat

### 1. Amendment sweep
Run the "Amending" workflow from `AGENTS.md` in full: group findings, check the threshold, attribute, amend via the `amend-prompt` skill, record the `PromptAmendment`. This is the only place amendments happen — never do this inline while recording a finding.

### 2. Retirement sweep
For every target project's `## Learned` section, check the cap (10 bullets) and the quiet-run threshold (20 runs since last retrigger) from `AGENTS.md`'s Hygiene Rules, and retire bullets into `.shogo/skills/learned-patterns/SKILL.md` as needed — independent of whether a new amendment is happening this cycle.

## Daily

### 3. Digest
Summarize the last 24 hours: findings recorded (by reviewer/category), amendments made (target + section), and any group approaching the threshold (2 of 3 needed) so a human can see what's coming before it lands. Keep this in memory/canvas — it's also what `harness`'s daily heartbeat asks me for via `project_call`.
