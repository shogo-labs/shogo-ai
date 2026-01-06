/**
 * Domain CVA Variants for Studio App
 * Task: task-variants
 *
 * Shared CVA variant definitions for domain-specific badge renderers.
 * These variants provide semantic coloring for platform-features schema enum fields.
 *
 * Color Semantics:
 * - RED: must, blocked, risk, failed
 * - AMBER: should, gap, hybrid, testing, implementation, test_failing
 * - BLUE: could, accepted, domain, discovery, analysis, classification, in_progress, implementing, unit
 * - GREEN: implemented, infrastructure, complete, verification, test_passing, passed, acceptance
 * - PURPLE: pattern, service, design, spec, integration
 * - GRAY: proposed, planned, pending
 */

import { cva } from "class-variance-authority"

const baseBadge = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"

/**
 * Priority badge variants (Requirement.priority)
 * must=red, should=amber, could=blue
 */
export const priorityBadgeVariants = cva(baseBadge, {
  variants: {
    priority: {
      must: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
      should: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      could: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    },
  },
  defaultVariants: { priority: "could" },
})

/**
 * Archetype badge variants (FeatureSession.featureArchetype, ClassificationDecision.validatedArchetype)
 * domain=blue, service=purple, infrastructure=green, hybrid=amber
 */
export const archetypeBadgeVariants = cva(baseBadge, {
  variants: {
    archetype: {
      domain: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      service: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      infrastructure: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      hybrid: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    },
  },
  defaultVariants: { archetype: "domain" },
})

/**
 * Finding type badge variants (AnalysisFinding.type)
 * pattern=purple, gap=amber, risk=red, etc.
 */
export const findingTypeBadgeVariants = cva(baseBadge, {
  variants: {
    type: {
      pattern: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      integration_point: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      risk: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
      gap: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      existing_test: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      verification: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      classification_evidence: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    },
  },
  defaultVariants: { type: "pattern" },
})

/**
 * Task status badge variants (ImplementationTask.status)
 * planned=gray, in_progress=blue, complete=green, blocked=red
 */
export const taskStatusBadgeVariants = cva(baseBadge, {
  variants: {
    status: {
      planned: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
      in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      blocked: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    },
  },
  defaultVariants: { status: "planned" },
})

/**
 * Test type badge variants (TestSpecification.testType)
 * unit=blue, integration=purple, acceptance=green
 */
export const testTypeBadgeVariants = cva(baseBadge, {
  variants: {
    testType: {
      unit: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      integration: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      acceptance: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    },
  },
  defaultVariants: { testType: "unit" },
})

/**
 * Session status badge variants (FeatureSession.status)
 * discovery=blue, analysis=blue, classification=blue, design=purple, spec=purple
 * implementation=amber, testing=amber, complete=green
 */
export const sessionStatusBadgeVariants = cva(baseBadge, {
  variants: {
    status: {
      discovery: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      analysis: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      classification: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      design: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      spec: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      implementation: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      testing: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    },
  },
  defaultVariants: { status: "discovery" },
})

/**
 * Requirement status badge variants (Requirement.status)
 * proposed=gray, accepted=blue, implemented=green
 */
export const requirementStatusBadgeVariants = cva(baseBadge, {
  variants: {
    status: {
      proposed: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
      accepted: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      implemented: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    },
  },
  defaultVariants: { status: "proposed" },
})

/**
 * Run status badge variants (ImplementationRun.status)
 * in_progress=blue, blocked=red, complete=green, failed=red
 */
export const runStatusBadgeVariants = cva(baseBadge, {
  variants: {
    status: {
      in_progress: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      blocked: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
      complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    },
  },
  defaultVariants: { status: "in_progress" },
})

/**
 * Execution status badge variants (TaskExecution.status)
 * pending=gray, test_written=blue, test_failing=amber, implementing=blue, test_passing=green, failed=red
 */
export const executionStatusBadgeVariants = cva(baseBadge, {
  variants: {
    status: {
      pending: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
      test_written: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      test_failing: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      implementing: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      test_passing: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    },
  },
  defaultVariants: { status: "pending" },
})

/**
 * Test case status badge variants (TestCase.status)
 * specified=gray, implemented=blue, passing=green
 */
export const testCaseStatusBadgeVariants = cva(baseBadge, {
  variants: {
    status: {
      specified: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
      implemented: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      passing: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
    },
  },
  defaultVariants: { status: "specified" },
})

/**
 * Change type badge variants (IntegrationPoint.changeType)
 * add=green, modify=blue, extend=purple, remove=red
 */
export const changeTypeBadgeVariants = cva(baseBadge, {
  variants: {
    changeType: {
      add: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      modify: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      extend: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      remove: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    },
  },
  defaultVariants: { changeType: "modify" },
})
