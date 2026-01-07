/**
 * Phase-specific system prompt templates for the platform feature pipeline.
 *
 * These templates guide Claude toward appropriate skill invocation at each phase
 * of the feature development lifecycle.
 *
 * @module phase-prompts
 */

/**
 * All valid phases in the platform feature pipeline
 */
export const PHASES = [
  'discovery',
  'analysis',
  'classification',
  'design',
  'spec',
  'testing',
  'implementation',
  'complete'
] as const

/**
 * Type representing valid pipeline phases
 */
export type Phase = (typeof PHASES)[number]

/**
 * Type guard to check if a value is a valid Phase
 */
export function isPhase(value: unknown): value is Phase {
  return typeof value === 'string' && PHASES.includes(value as Phase)
}

/**
 * Phase-specific system prompt templates.
 *
 * Each template includes:
 * 1. Phase context description
 * 2. Skill to invoke (e.g., /platform-feature-discovery)
 * 3. Expected outcome
 */
export const PHASE_PROMPTS: Record<Phase, string> = {
  discovery: `## Discovery Phase

You are helping capture requirements for a new platform feature. Your goal is to understand the user's needs, identify key artifacts, and document the problem space.

**To run the discovery process, invoke:** /platform-feature-discovery

**Expected outcome:** FeatureSession and Requirement entities will be captured in Wavesmith, documenting the user's intent, problem description, and initial requirements.

Guide the conversation to understand:
- What problem is the user trying to solve?
- What artifacts or examples do they have?
- What are the key requirements and constraints?`,

  analysis: `## Analysis Phase

You are analyzing the captured requirements to identify patterns, dependencies, and implementation considerations.

**To run the analysis process, invoke:** /platform-feature-analysis

**Expected outcome:** Analysis entities will be generated in Wavesmith, documenting patterns found, technical considerations, and dependency mappings.

Focus on:
- Reviewing captured requirements from discovery
- Identifying patterns and anti-patterns
- Mapping dependencies between requirements
- Flagging technical risks or considerations`,

  classification: `## Classification Phase

You are classifying the analyzed requirements to determine implementation priorities and categorization.

**To run the classification process, invoke:** /platform-feature-classification

**Expected outcome:** Classification entities will be created in Wavesmith, categorizing requirements by type, priority, and implementation approach.

Determine:
- Requirement categories (functional, non-functional, technical)
- Priority levels (must-have, should-have, nice-to-have)
- Implementation complexity estimates
- Groupings for phased delivery`,

  design: `## Design Phase

You are designing the schema and data model based on classified requirements.

**To run the design process, invoke:** /platform-feature-design

**Expected outcome:** Schema designs will be generated as Enhanced JSON Schema definitions in Wavesmith, ready for implementation.

Design considerations:
- Entity definitions and relationships
- Property types and validations
- Reference patterns (single, array, computed)
- MST-specific extensions (x-arktype, x-mst-type)`,

  spec: `## Specification Phase

You are creating detailed implementation specifications from the approved schema design.

**To run the specification process, invoke:** /platform-feature-spec

**Expected outcome:** Implementation spec entities will be created in Wavesmith, defining modules, interfaces, and integration points.

Specification includes:
- Module boundaries and responsibilities
- Interface definitions and contracts
- Integration touchpoints
- Configuration and environment requirements`,

  testing: `## Testing Phase

You are generating test specifications based on the implementation spec.

**To run the test generation process, invoke:** /platform-feature-tests

**Expected outcome:** Test spec entities will be created in Wavesmith, defining TDD-ready test cases for each module and interface.

Test coverage includes:
- Unit tests for individual functions
- Integration tests for module interactions
- Edge cases and error handling
- Performance and boundary conditions`,

  implementation: `## Implementation Phase

You are generating production code based on the test specifications and implementation spec.

**To run the implementation process, invoke:** /platform-feature-implementation

**Expected outcome:** TDD-ready code scaffolding will be generated, with tests written first and implementation following.

Implementation approach:
- Test files generated first (TDD)
- Implementation files with stubs
- Type definitions and interfaces
- Integration with existing codebase`,

  complete: `## Pipeline Complete

The platform feature pipeline has completed successfully. All phases have been executed and the feature artifacts have been generated.

**Result:** The feature has been fully processed through the pipeline.

Summary of captured artifacts:
- Discovery: Requirements and problem documentation
- Analysis: Pattern analysis and technical considerations
- Classification: Priority and categorization decisions
- Design: Schema definitions (Enhanced JSON Schema)
- Spec: Module and interface specifications
- Testing: TDD test specifications
- Implementation: Generated code scaffolding

You can now review the generated artifacts or start a new feature session.`
}

/**
 * Get the prompt template for a specific phase
 */
export function getPhasePrompt(phase: Phase): string {
  return PHASE_PROMPTS[phase]
}

/**
 * Get the skill command for a phase (empty string for 'complete' phase)
 */
export function getPhaseSkill(phase: Phase): string {
  const skillMap: Record<Phase, string> = {
    discovery: '/platform-feature-discovery',
    analysis: '/platform-feature-analysis',
    classification: '/platform-feature-classification',
    design: '/platform-feature-design',
    spec: '/platform-feature-spec',
    testing: '/platform-feature-tests',
    implementation: '/platform-feature-implementation',
    complete: ''
  }
  return skillMap[phase]
}
