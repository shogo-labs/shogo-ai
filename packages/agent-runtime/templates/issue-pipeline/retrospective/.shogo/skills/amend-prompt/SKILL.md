---
name: amend-prompt
version: 1.0.0
description: Detect recurring accepted findings and amend the owning project's `## Learned` section — the in-the-wild prompt evolution loop
trigger: "amendment sweep|recurring finding|amend prompt|learned section"
tools: [exec, read_file, write_file, project_attach]
---

# Amend Prompt

Run on heartbeat only. Follow `AGENTS.md`'s "Amending" workflow and Hygiene Rules exactly — re-read them before every sweep, this is the part most likely to silently drift if rushed.

1. **Query** `Finding` grouped by `(reviewer, category, accepted)`, excluding rows already cited by an existing `PromptAmendment` for that group. Count **distinct `runId`s**, not rows.
2. **Threshold check**: skip any group under 3 distinct runIds.
3. **Attribute** the target project per `AGENTS.md`'s rules (`planner` / `implementer` / the reviewer itself).
4. **Attach if needed**: `project_attach({ project: "Issue Pipeline — <Target>", mode: "readwrite" })` (idempotent — safe to call even if already attached).
5. **Read the target's `AGENTS.md`.** Find the exact `## Learned` heading and the next `##` heading (or EOF). This is the ONLY span you may modify.
6. **Compose the bullet**:
   ```
   - [YYYY-MM-DD] <imperative lesson, 1-2 sentences, specific enough to change behavior — not "be more careful about X"> (runs: <runId1>, <runId2>, <runId3>, ...)
   ```
   Write the lesson as an instruction to the agent, not a description of the bug — e.g. "Always paginate list endpoints backed by a table with no upper bound on row count; check for an existing `cursor`/`limit` pattern in sibling endpoints before adding a new one." not "list endpoints sometimes have unbounded queries."
7. **Cap and retire** per the Hygiene Rules: if the section is already at 10 bullets, move the oldest not-recently-retriggered one into `.shogo/skills/learned-patterns/SKILL.md` (create with a frontmatter block if it doesn't exist — `name: learned-patterns`, `description: Retired lessons from the retrospective loop, still available on demand`, a broad `trigger`) before appending the new one. Also sweep for bullets past the 20-quiet-run threshold independent of the cap.
8. **Write the file** — the `## Learned` section content only, nothing else in the file changes.
9. **Checkpoint with a runId-citing message**: `retrospective: amend <target> ## Learned — <category> (runs: <runId1>, <runId2>, <runId3>)`.
10. **Record** a `PromptAmendment` row (targetKey, reviewer if applicable, category, reason, summary = the exact bullet text, findingIds, runIds) so this group is excluded from future sweeps until it recurs again post-amendment.

If a target's `## Learned` section is missing entirely (a human deleted it, or a custom module doesn't have one), do not invent a location — skip the amendment, note it in the daily digest, and let a human add the heading back.
