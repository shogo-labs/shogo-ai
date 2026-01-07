/**
 * Domain CVA Variants for Studio App
 * Task: task-variants, task-w1-phase-color-variants
 *
 * Shared CVA variant definitions for domain-specific badge renderers.
 * These variants provide semantic coloring for platform-features schema enum fields.
 *
 * Color Semantics:
 * - RED: must, blocked, risk, failed, implementation phase
 * - AMBER: should, gap, hybrid, design phase
 * - BLUE: could, accepted, domain, discovery phase, in_progress, implementing, unit
 * - GREEN: implemented, infrastructure, complete phase, verification, test_passing, passed, acceptance
 * - PURPLE: pattern, service, analysis phase
 * - PINK: classification phase
 * - CYAN: testing phase
 * - EMERALD: spec phase
 * - GRAY: proposed, planned, pending
 *
 * Phase Colors (Orchestrated Precision Design System):
 * - Discovery: blue-500 (#3b82f6)
 * - Analysis: violet-500 (#8b5cf6)
 * - Classification: pink-500 (#ec4899)
 * - Design: amber-500 (#f59e0b)
 * - Spec: emerald-500 (#10b981)
 * - Testing: cyan-500 (#06b6d4)
 * - Implementation: red-500 (#ef4444)
 * - Complete: green-500 (#22c55e)
 */

import { cva, type VariantProps } from "class-variance-authority"

/**
 * All valid phase values for the feature pipeline
 */
export const PHASE_VALUES = [
  "discovery",
  "analysis",
  "classification",
  "design",
  "spec",
  "testing",
  "implementation",
  "complete",
] as const

/**
 * TypeScript type for phase values
 */
export type PhaseType = typeof PHASE_VALUES[number]

/**
 * Phase color variants for applying phase-specific colors to any component
 * Task: task-w1-phase-color-variants
 *
 * Uses the design tokens from index.css (--phase-discovery, --phase-analysis, etc.)
 * with Tailwind's arbitrary value syntax for CSS variable references.
 *
 * @example
 * ```tsx
 * <div className={phaseColorVariants({ phase: "discovery", variant: "bg" })}>
 *   Discovery Phase Content
 * </div>
 * ```
 */
export const phaseColorVariants = cva("", {
  variants: {
    phase: {
      discovery: "",
      analysis: "",
      classification: "",
      design: "",
      spec: "",
      testing: "",
      implementation: "",
      complete: "",
    },
    variant: {
      bg: "",
      text: "",
      border: "",
      ring: "",
      default: "",
    },
  },
  compoundVariants: [
    // Discovery (blue)
    { phase: "discovery", variant: "bg", className: "bg-blue-500 dark:bg-blue-400" },
    { phase: "discovery", variant: "text", className: "text-blue-500 dark:text-blue-400" },
    { phase: "discovery", variant: "border", className: "border-blue-500 dark:border-blue-400" },
    { phase: "discovery", variant: "ring", className: "ring-blue-500 dark:ring-blue-400" },
    { phase: "discovery", variant: "default", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },

    // Analysis (violet)
    { phase: "analysis", variant: "bg", className: "bg-violet-500 dark:bg-violet-400" },
    { phase: "analysis", variant: "text", className: "text-violet-500 dark:text-violet-400" },
    { phase: "analysis", variant: "border", className: "border-violet-500 dark:border-violet-400" },
    { phase: "analysis", variant: "ring", className: "ring-violet-500 dark:ring-violet-400" },
    { phase: "analysis", variant: "default", className: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400" },

    // Classification (pink)
    { phase: "classification", variant: "bg", className: "bg-pink-500 dark:bg-pink-400" },
    { phase: "classification", variant: "text", className: "text-pink-500 dark:text-pink-400" },
    { phase: "classification", variant: "border", className: "border-pink-500 dark:border-pink-400" },
    { phase: "classification", variant: "ring", className: "ring-pink-500 dark:ring-pink-400" },
    { phase: "classification", variant: "default", className: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400" },

    // Design (amber)
    { phase: "design", variant: "bg", className: "bg-amber-500 dark:bg-amber-400" },
    { phase: "design", variant: "text", className: "text-amber-500 dark:text-amber-400" },
    { phase: "design", variant: "border", className: "border-amber-500 dark:border-amber-400" },
    { phase: "design", variant: "ring", className: "ring-amber-500 dark:ring-amber-400" },
    { phase: "design", variant: "default", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" },

    // Spec (emerald)
    { phase: "spec", variant: "bg", className: "bg-emerald-500 dark:bg-emerald-400" },
    { phase: "spec", variant: "text", className: "text-emerald-500 dark:text-emerald-400" },
    { phase: "spec", variant: "border", className: "border-emerald-500 dark:border-emerald-400" },
    { phase: "spec", variant: "ring", className: "ring-emerald-500 dark:ring-emerald-400" },
    { phase: "spec", variant: "default", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" },

    // Testing (cyan)
    { phase: "testing", variant: "bg", className: "bg-cyan-500 dark:bg-cyan-400" },
    { phase: "testing", variant: "text", className: "text-cyan-500 dark:text-cyan-400" },
    { phase: "testing", variant: "border", className: "border-cyan-500 dark:border-cyan-400" },
    { phase: "testing", variant: "ring", className: "ring-cyan-500 dark:ring-cyan-400" },
    { phase: "testing", variant: "default", className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400" },

    // Implementation (red)
    { phase: "implementation", variant: "bg", className: "bg-red-500 dark:bg-red-400" },
    { phase: "implementation", variant: "text", className: "text-red-500 dark:text-red-400" },
    { phase: "implementation", variant: "border", className: "border-red-500 dark:border-red-400" },
    { phase: "implementation", variant: "ring", className: "ring-red-500 dark:ring-red-400" },
    { phase: "implementation", variant: "default", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },

    // Complete (green)
    { phase: "complete", variant: "bg", className: "bg-green-500 dark:bg-green-400" },
    { phase: "complete", variant: "text", className: "text-green-500 dark:text-green-400" },
    { phase: "complete", variant: "border", className: "border-green-500 dark:border-green-400" },
    { phase: "complete", variant: "ring", className: "ring-green-500 dark:ring-green-400" },
    { phase: "complete", variant: "default", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
  ],
  defaultVariants: {
    variant: "default",
  },
})

export type PhaseColorVariantsProps = VariantProps<typeof phaseColorVariants>

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
