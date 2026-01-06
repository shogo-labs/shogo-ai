# Subagent Completion Guide

When invoked by the orchestrator via Task tool, follow this guide when completing your work.

## Purpose

The orchestrator invokes skills in isolated context windows to keep the main thread lean. Your completion summary is the only information the orchestrator receives - it must contain enough detail for informed decision-making.

## What to Surface

### 1. What You Accomplished

- Artifacts created (entity types, IDs, counts)
- Files modified (if any)
- Status transitions made

### 2. Key Decisions Made

For each significant decision:
- What you decided
- Why (the rationale)
- What alternatives were considered (if relevant)

The orchestrator and user need to evaluate whether your decisions align with intent. Provide enough rationale that they can assess soundness without re-exploring.

### 3. Assumptions Made

For each assumption:
- What you assumed
- What downstream work depends on this assumption
- What would indicate the assumption is wrong

Assumptions are things you treated as true without verification. Making assumptions is fine - hiding them is not.

### 4. Uncertainties

For each uncertainty:
- What remains unclear
- Why it couldn't be resolved
- What would help resolve it
- Whether it blocks proceeding

Surface anything the user should weigh in on before downstream phases proceed.

## Format

Use natural language, not rigid schemas. The goal is decision-quality fidelity - enough detail that the reader can make informed decisions about whether to proceed, revise, or dig deeper.

Good completion summary structure:
```
## {Skill Name} Complete

### Summary
{What was accomplished - artifacts, status}

### Decisions
{Key decisions with rationale}

### Assumptions
{What you assumed and its downstream impact}

### Uncertainties
{Open questions, potential issues}

### Ready for Next Phase
{Yes/No/Conditional - and why}
```

## Principles

**Surface concerns, don't bury them.** If something feels off, say so. The orchestrator can handle uncertainty; it can't handle hidden problems that compound downstream.

**Provide rationale, not just conclusions.** "Classified as Service" is less useful than "Classified as Service because requirements mention external API integration and credential management."

**Be specific about downstream impact.** "This assumption affects design" is less useful than "This assumption affects design - if wrong, the schema will need foreign key relationships instead of embedded data."

**Make the implicit explicit.** If you made a judgment call, say so. If you interpreted ambiguous requirements, explain your interpretation.
