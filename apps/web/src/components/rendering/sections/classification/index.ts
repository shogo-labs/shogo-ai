/**
 * Classification Phase Section Components
 * Tasks: task-classification-001 through task-classification-010
 *
 * Exports the 6 section components for the Classification phase composable view:
 * 1. ArchetypeTransformationSection - Header with initial->validated archetype transition
 * 2. CorrectionNoteSection - Conditional correction notice when archetype changed
 * 3. ConfidenceMetersSection - Archetype confidence progress bars
 * 4. EvidenceColumnsSection - Dual column supporting/opposing evidence
 * 5. ApplicablePatternsSection - Pattern chips from feature
 * 6. ClassificationRationaleSection - Rationale text in themed card
 *
 * Pattern: Pure slot composition - no React Context provider needed.
 * Each section reads directly from useDomains() hook.
 */

export { ArchetypeTransformationSection } from "./ArchetypeTransformationSection"
export { CorrectionNoteSection } from "./CorrectionNoteSection"
export { ConfidenceMetersSection } from "./ConfidenceMetersSection"
export { EvidenceColumnsSection } from "./EvidenceColumnsSection"
export { ApplicablePatternsSection } from "./ApplicablePatternsSection"
export { ClassificationRationaleSection } from "./ClassificationRationaleSection"
