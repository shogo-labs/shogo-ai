# Platform Feature Skill Tree Documentation Plan

> **Status**: Planning complete, ready for sequential execution with review gates
> **Created**: 2024-12-07
> **Location**: Obsidian vault for reference; execution will create sibling files

---

## Overview

**Goal**: Create human-centric developer onboarding documentation that enables new developers to use the 6-skill pipeline to add features to the Shogo AI platform.

**Primary Audience**: Developers new to the platform who need to start adding features

**Secondary Goal**: Bolster understanding with architectural fundamentals (Wavesmith, patterns, "runtime as projection")

**Out of Scope**: App-builder skills (external apps), exhaustive troubleshooting

**Canonical Example**: Auth feature (Supabase implementation from Round 9 eval)

---

## Design Decisions

1. **Structure**: Holistic overview first, then dedicated component sections. Emphasize both e2e flow AND modular/resumable usage.

2. **Diagrams**: Contextual Mermaid diagrams as needed. Canonical flow diagram for system overview, granular diagrams in supporting contexts.

3. **Code Examples**: Snippets + references to source files. Full files stay in repo.

4. **Progressive Disclosure**: Explain Wavesmith/entity concepts as they become relevant ("here's what's happening"), not front-loaded or deferred.

5. **Tone**: Balanced - contextual enough to build understanding, swift enough to reach actionability.

6. **Organization**: Let structure flow naturally from content needs.

---

## Session Recontextualization Guidance

### For Future Sessions / Agent Contextualization

When resuming this work or spinning up agents for documentation tasks:

**Key Context Sources**:
1. **Git Branch**: `feat/platform-feature-skills-supbase-eval-case-testing-round-9` - Contains final skill tree + generated auth implementation
2. **Skill Definitions**: `.claude/skills/platform-feature-*/SKILL.md` - LLM-facing skill instructions (6 skills)
3. **Pattern References**: `.claude/skills/platform-feature-*/references/patterns/*.md` - 7 architectural patterns
4. **Wavesmith Schemas**: `.schemas/platform-features/` and `.schemas/platform-feature-spec/` - Entity definitions
5. **Generated Auth Code**: `packages/state-api/src/auth/` and `apps/web/src/contexts/AuthContext.tsx`
6. **Obsidian Planning**: `_analysis/wavesmith/wavesmith-odin/shogo-ai/platform-feature-meta-skills/` - Evolution docs and eval iterations

**Core Concepts to Prime**:
- "Runtime as Projection over Intent" - User intent captured as Wavesmith entities, progressively refined into code
- 6-Skill Pipeline: Discovery → Analysis → Design → Spec → Tests → Implementation
- Two-Schema Model: `platform-features` (intent/requirements) + `platform-feature-spec` (implementation artifacts)
- 7 Architectural Patterns: Isomorphism, Service Interface, Environment Extension, Enhancement Hooks, Mock Testing, Provider Sync, React Context
- Isomorphism Principle: Domain logic → `packages/state-api`, React UI → `apps/web`

**Key Design Decisions in the System**:
- Collection pattern for all entities (no singletons)
- Single `domain.ts` with all enhancement hooks (never split)
- Service interface abstraction always required
- TDD per-task (not batch): RED → GREEN cycle
- Schema always required (local MST state for every feature)

---

## Deliverables

### Document 1: Platform Feature Development Overview
**File**: `01-overview.md`
**Purpose**: Holistic orientation - balanced context + action-readiness

**Content**:
- The goal: Adding platform features through AI-orchestrated development
- "Runtime as Projection over Intent" - philosophy in accessible terms
- The 6-skill pipeline at a glance (canonical flow diagram)
- How architecture supports the flow (Wavesmith captures intent, skills transform it)
- Key affordances: e2e execution OR modular/resumable work
- Navigation guide to the rest of the docs

**Diagram**: Canonical pipeline flow (Discovery → Analysis → Design → Spec → Tests → Implementation)

**Tone**: Contextual enough to build understanding, swift enough to reach actionability

---

### Document 2: Pipeline Guide (Hybrid Structure)
**Directory**: `02-pipeline/`
**Purpose**: Walkthrough of each skill with linked individual pages

**Structure**:
```
02-pipeline/
├── index.md          # Pipeline overview, how skills connect, when to use each
├── discovery.md      # Skill 1: Capturing intent
├── analysis.md       # Skill 2: Exploring patterns (EXPLORE + VERIFY modes)
├── design.md         # Skill 3: Schema creation
├── spec.md           # Skill 4: Task breakdown
├── tests.md          # Skill 5: Test specifications
└── implementation.md # Skill 6: TDD execution
```

**Each skill page contains**:
- Purpose and role in the pipeline
- What triggers it / when to invoke
- Key inputs (entities from previous stages)
- What it produces (entities, schemas, code)
- What to look for in outputs
- Auth example: illustrative snippet
- Link to next skill in sequence

**Diagrams**: Per-skill input/output diagrams where helpful

---

### Document 3: Architectural Patterns
**File**: `03-patterns.md`
**Purpose**: The 7 patterns that make generated code idiomatic

**Content**:
- Why patterns matter (consistency, testability, maintainability)
- Pattern overview table (quick reference)
- Each pattern explained:
  1. Isomorphism (package placement)
  2. Service Interface (abstraction)
  3. Environment Extension (DI)
  4. Enhancement Hooks (domain logic)
  5. Mock Service Testing
  6. Provider Synchronization
  7. React Context Integration
- How patterns connect to skill outputs
- Auth example: where each pattern appears in generated code

**Diagram**: Architecture diagram showing state-api vs apps/web split

---

### Document 4: Working with Wavesmith
**File**: `04-wavesmith.md`
**Purpose**: Understanding the entity layer that powers the pipeline

**Content**:
- What Wavesmith is (schema-first reactive state)
- The two-schema model (platform-features + platform-feature-spec)
- Key entities and when you encounter them
- How skills read from and write to Wavesmith
- Querying and inspecting session state
- Traceability: following the chain from code back to intent

**Diagram**: Entity relationship diagram showing cross-schema references

---

### Document 5: Modular Usage & Session Management
**File**: `05-modular-usage.md`
**Purpose**: How to work incrementally, resume sessions, iterate

**Content**:
- Session state and status flow
- Picking up where you left off (querying existing sessions)
- Re-running skills (when and why)
- Analysis VERIFY mode (pre-implementation drift detection)
- Handling blocked tasks and recovery
- Iterating on design decisions

**Diagram**: Session status state machine

---

### Document 6: Quick Reference
**File**: `06-reference.md`
**Purpose**: Scannable lookup for common needs

**Content**:
- Skill invocation cheat sheet
- Entity quick reference (what each entity type captures)
- Status flow diagram
- Pattern applicability matrix (which patterns for which feature types)
- Common Wavesmith operations

---

## File Structure

```
documentation-strategy-planning/
├── 00-documentation-plan.md  # This file
├── 01-overview.md
├── 02-pipeline/
│   ├── index.md
│   ├── discovery.md
│   ├── analysis.md
│   ├── design.md
│   ├── spec.md
│   ├── tests.md
│   └── implementation.md
├── 03-patterns.md
├── 04-wavesmith.md
├── 05-modular-usage.md
└── 06-reference.md
```

**Total**: 12 content files + 1 plan file

---

## Execution Sequence

Recommended writing order (dependencies flow downward):

1. **01-overview.md** - Sets context for everything else
2. **02-pipeline/index.md** - Pipeline overview, links to skills
3. **02-pipeline/discovery.md** through **implementation.md** - Individual skills
4. **03-patterns.md** - References auth examples from pipeline docs
5. **04-wavesmith.md** - Builds on entity concepts introduced in pipeline
6. **05-modular-usage.md** - Assumes familiarity with pipeline
7. **06-reference.md** - Consolidates from all above

**Review Process**: Sequential execution with review gates after each document.

---

## Reading Order (For New Developers)

1. **Overview** → Get oriented
2. **Pipeline Index** → Understand the flow
3. **Individual skill pages** → As needed during first feature
4. **Start using the system** → Invoke skills on a real feature
5. **Patterns** → When reviewing generated code
6. **Wavesmith** → When curious about underlying mechanism
7. **Modular Usage** → For longer-running features
8. **Quick Reference** → Ongoing lookup

---

## Progress Tracking

| Document | Status | Notes |
|----------|--------|-------|
| 00-documentation-plan.md | ✅ Complete | This file |
| 01-overview.md | ⏳ Pending | First to write |
| 02-pipeline/index.md | ⏳ Pending | |
| 02-pipeline/discovery.md | ⏳ Pending | |
| 02-pipeline/analysis.md | ⏳ Pending | |
| 02-pipeline/design.md | ⏳ Pending | |
| 02-pipeline/spec.md | ⏳ Pending | |
| 02-pipeline/tests.md | ⏳ Pending | |
| 02-pipeline/implementation.md | ⏳ Pending | |
| 03-patterns.md | ⏳ Pending | |
| 04-wavesmith.md | ⏳ Pending | |
| 05-modular-usage.md | ⏳ Pending | |
| 06-reference.md | ⏳ Pending | |
# Progress Tracking
## Progress Tracking

| Document | Status | Notes |
|----------|--------|-------|
| 00-documentation-plan.md | ✅ Complete | Master plan with contextualization guidance |
| 01-overview.md | ✅ Complete | Pipeline philosophy and quick start |
| 02-pipeline/index.md | ✅ Complete | Pipeline hub with flowchart |
| 02-pipeline/discovery.md | ✅ Complete | Discovery skill guide |
| 02-pipeline/analysis.md | ✅ Complete | Analysis skill with EXPLORE/VERIFY modes |
| 02-pipeline/design.md | ✅ Complete | Schema creation guide |
| 02-pipeline/spec.md | ✅ Complete | Task breakdown guide |
| 02-pipeline/tests.md | ✅ Complete | Test specification guide |
| 02-pipeline/implementation.md | ✅ Complete | TDD execution guide |
| 03-patterns.md | ✅ Complete | 7 architectural patterns |
| 04-wavesmith.md | ✅ Complete | Entity layer and operations |
| 05-modular-usage.md | ✅ Complete | Session management and iteration |
| 06-reference.md | ✅ Complete | Quick reference lookup |

**All 12 documents complete.**
