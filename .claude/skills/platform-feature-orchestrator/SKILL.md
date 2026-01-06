---
name: platform-feature-orchestrator
description: Orchestrate the platform feature pipeline end-to-end. Use when user wants to build a new platform feature, resume an existing feature session, or run the full pipeline (discovery → analysis → classification → design → spec → tests → implementation). Invokes each skill via subagents for context isolation, manages review gates between phases, and keeps the main thread lean.
---

# Platform Feature Orchestrator

Orchestrate the platform feature pipeline by invoking skills via subagents and managing review gates between phases.

## When to Use

- User says "build a feature", "create a platform feature", "run the pipeline"
- User says "resume session X" or "continue feature X"
- User wants end-to-end orchestrated feature development

## Pipeline Overview

```
discovery → analysis[explore] → classification → design → spec → tests → analysis[verify] → implementation
```

Each skill runs in an isolated context window via Task tool subagent. The orchestrator sees only the completion summary, keeping the main thread lean.

## Phase 1: Determine Current State

### New Feature

If user describes a new feature without specifying a session:

```
Starting new platform feature.
Next: platform-feature-discovery

Proceed?
```

### Existing Session

If user provides a session name or ID:

```javascript
const session = await store.query({
  model: "FeatureSession",
  schema: "platform-features",
  filter: { name: sessionName }  // or { id: sessionId }
})
```

Present current state:

```
Session: {session.name}
Status: {session.status}
Next skill: {determined from status}

Resume from {next skill}?
```

See [pipeline-status-flow.md](references/pipeline-status-flow.md) for status → skill mapping.

## Phase 2: Invoke Skill via Subagent

For the identified skill, use the Task tool:

```
Task tool call:
  subagent_type: "general-purpose"
  run_in_background: false
  prompt: |
    Execute /{skill-name} for session {sessionId}.

    {If resuming, include relevant context from prior completions}

    Before completing, read the completion guidelines at:
    .claude/skills/platform-feature-orchestrator/references/subagent-completion-guide.md

    Follow those guidelines when providing your completion summary.
    The orchestrator needs enough detail to make informed decisions
    about whether to proceed, revise, or dig deeper.
```

### Skill-Specific Context

Include additional context based on which skill is being invoked:

**discovery**: No prior context needed - this is the first skill.

**analysis (explore)**: Include preliminary archetype from discovery.

**classification**: Include initial assessment and key analysis findings.

**design**: Include validated archetype and applicable patterns.

**spec**: Include schema name and enhancement hooks plan from design.

**tests**: Include task IDs and acceptance criteria summaries. Note: After tests completes, proceed to analysis (verify) - both run at "testing" status.

**analysis (verify)**: Include integration point locations from spec. Note: This runs AFTER tests skill at "testing" status.

**implementation**: Include task dependency structure and test spec summaries.

## Phase 3: Review Gate

When subagent completes, present its summary to the user:

```
┌─────────────────────────────────────────────────────────────┐
│ {Skill Name} Complete                                       │
│                                                             │
│ {Subagent's completion summary}                             │
│                                                             │
│ Options:                                                    │
│ • Proceed to {next skill}                                   │
│ • Ask questions about the work done                         │
│ • Request revisions before proceeding                       │
│ • Pause pipeline (can resume later)                         │
└─────────────────────────────────────────────────────────────┘
```

### Handling User Response

**Proceed**: Go to Phase 2 with the next skill in sequence.

**Questions**: Answer based on the summary. If deeper investigation needed, spawn a focused subagent to explore specific concerns.

**Revisions**: Clarify what needs to change, then spawn subagent to re-run the skill with the revision context. Return to review gate when complete.

**Pause**: Confirm session state is persisted. User can resume later with "resume session {name}".

### Blocked Status

If subagent reports blocked status:

```
{Skill Name} Blocked

Reason: {blocker from summary}

Options:
• Resolve the blocker and retry
• Skip this skill (if possible)
• Abort the pipeline
```

Not all skills can be skipped - consult [pipeline-status-flow.md](references/pipeline-status-flow.md).

## Phase 4: Pipeline Completion

When implementation completes successfully:

```
Pipeline Complete: {session.name}

Phases completed:
• Discovery: {requirement count} requirements
• Analysis: {finding count} findings
• Classification: {archetype}
• Design: {schema name}
• Spec: {task count} tasks
• Tests: {test count} specifications
• Implementation: {completed}/{total} tasks

All tests passing. Feature ready for review.
```

## Context Management

### What the Orchestrator Maintains

- Session ID/name
- Current status
- Completed phases (1-2 sentence summaries each)
- Active concerns/uncertainties carried forward
- User decisions made at review gates

### What the Orchestrator Does NOT Maintain

- Full exploration context from analysis
- Complete schema content from design
- All test specifications from tests
- Implementation details from subagents

These stay in subagent context windows. The orchestrator sees summaries only.

## References

- [subagent-completion-guide.md](references/subagent-completion-guide.md) - What subagents must surface when completing
- [pipeline-status-flow.md](references/pipeline-status-flow.md) - Status transitions and skill sequencing
