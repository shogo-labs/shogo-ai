# Pipeline Status Flow

## Status Transitions

```
null/new → discovery → classification → design → spec → testing → implementation → complete
                ↑                                           ↑
                └── analysis (explore mode)                 └── tests, then analysis (verify mode)
```

## Skill Sequence

| Current Status | Next Skill | Skill Sets Status To |
|----------------|------------|---------------------|
| null/new | platform-feature-discovery | discovery |
| discovery | platform-feature-analysis (explore) | classification |
| classification | platform-feature-classification | design |
| design | platform-feature-design | spec |
| spec | platform-feature-spec | testing |
| testing | platform-feature-tests | testing |
| testing | platform-feature-analysis (verify) | implementation |
| implementation | platform-feature-implementation | complete |

**Note:** When status is "testing", the orchestrator runs tests skill first, then analysis verify. Both expect "testing" status - the orchestrator controls the sequence.

## Skill Responsibilities

### discovery
- Captures user intent
- Creates FeatureSession with initial archetype assessment
- Creates 3-7 Requirement entities

### analysis (explore mode)
- Explores codebase for patterns, gaps, risks
- Creates AnalysisFinding entities including classification evidence
- Informs classification with codebase facts

### classification
- Validates/corrects archetype using evidence
- Creates ClassificationDecision entity
- Sets applicable patterns for implementation

### design
- Creates Enhanced JSON Schema
- Registers schema via Wavesmith
- Creates DesignDecision entities including enhancement hooks plan

### spec
- Creates ImplementationTask entities from integration points
- Establishes task dependencies
- Defines acceptance criteria

### tests
- Creates TestSpecification entities from acceptance criteria
- Maps criteria to Given/When/Then format
- Covers unit, integration, acceptance, e2e

### analysis (verify mode)
- Validates spec still aligns with codebase
- Detects drift since exploration
- Reports conflicts or changes

### implementation
- Executes TDD for each task
- Uses subagents for task execution
- Runs integration verification

## Session Entity

The orchestrator queries FeatureSession to determine current state:

```javascript
const session = await store.query({
  model: "FeatureSession",
  schema: "platform-features",
  filter: { id: sessionId }  // or { name: sessionName }
})

// Key fields:
// session.status - determines next skill
// session.name - for display
// session.initialAssessment - archetype indicators
// session.schemaName - set after design
```

## Error States

If a skill reports blocked status, the orchestrator should:
1. Present the blocker to the user
2. Offer options: resolve, skip (if possible), or abort
3. Not automatically proceed to the next skill
