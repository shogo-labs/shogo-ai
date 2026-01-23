/**
 * Generic Phase Color Variants
 *
 * Shared CVA variant definitions for phase-based coloring.
 * These variants provide semantic coloring for any phase-based workflow.
 *
 * Phase Colors:
 * - Discovery: blue-500
 * - Analysis: violet-500
 * - Classification: pink-500
 * - Design: amber-500
 * - Spec: emerald-500
 * - Testing: cyan-500
 * - Implementation: red-500
 * - Complete: green-500
 */

import { cva, type VariantProps } from "class-variance-authority"

/**
 * All valid phase values for phase-based workflows
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
 *
 * Uses Tailwind color classes for phase-based styling.
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
