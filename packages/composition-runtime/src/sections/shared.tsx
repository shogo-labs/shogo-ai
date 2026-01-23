/**
 * Section Shared Utilities
 * Task: task-prephase-004
 *
 * Provides reusable components and hooks for section implementations.
 * Reduces duplication across 30+ section components by providing:
 * - SectionCard: wrapper with consistent phase-colored border styling
 * - SectionHeader: icon + title + optional count badge pattern
 * - EmptySectionState: configurable empty state display
 * - usePhaseColorFromContext: reads phase from CompositionContext
 *
 * @example
 * ```tsx
 * // Use in a section component
 * function MySection({ feature }: SectionRendererProps) {
 *   const phaseColors = usePhaseColorFromContext()
 *
 *   return (
 *     <SectionCard phaseColors={phaseColors}>
 *       <SectionHeader
 *         icon={<Search className="h-4 w-4" />}
 *         title="My Section"
 *         count={items.length}
 *         phaseColors={phaseColors}
 *       />
 *       {items.length === 0 ? (
 *         <EmptySectionState
 *           icon={Search}
 *           message="No items found"
 *         />
 *       ) : (
 *         // render items
 *       )}
 *     </SectionCard>
 *   )
 * }
 * ```
 */

import React, { createContext, useContext, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "../utils/cn"
import { usePhaseColor, type PhaseColors } from "../hooks/usePhaseColor"

// =============================================================================
// CompositionContext - Provides phase information to descendants
// =============================================================================

/**
 * Value provided by CompositionContext.
 * Contains the dataContext from the current Composition entity.
 */
export interface CompositionContextValue {
  /** Phase name from Composition.dataContext.phase */
  phase: string
  /** Full dataContext object for future extensibility */
  dataContext?: Record<string, unknown>
}

/**
 * Default context value when no provider is present.
 * Falls back to 'discovery' phase as a safe default.
 */
const defaultCompositionContext: CompositionContextValue = {
  phase: "discovery",
  dataContext: { phase: "discovery" },
}

/**
 * Context for composition data.
 * Provides phase information to section components.
 */
const CompositionContext = createContext<CompositionContextValue>(defaultCompositionContext)

/**
 * Provider props for CompositionProvider.
 */
export interface CompositionProviderProps {
  /** Children to render */
  children: ReactNode
  /** The phase name (from Composition.dataContext.phase) */
  phase: string
  /** Optional full dataContext */
  dataContext?: Record<string, unknown>
}

/**
 * Provider component that wraps section components with composition context.
 * Used by ComposablePhaseView to provide dataContext to all sections.
 *
 * @example
 * ```tsx
 * <CompositionProvider phase="analysis" dataContext={{ phase: "analysis" }}>
 *   <SlotLayout>{children}</SlotLayout>
 * </CompositionProvider>
 * ```
 */
export function CompositionProvider({
  children,
  phase,
  dataContext,
}: CompositionProviderProps) {
  const value: CompositionContextValue = {
    phase,
    dataContext: dataContext ?? { phase },
  }

  return (
    <CompositionContext.Provider value={value}>
      {children}
    </CompositionContext.Provider>
  )
}

CompositionProvider.displayName = "CompositionProvider"

/**
 * Hook to access the composition context.
 * Returns phase and dataContext from nearest CompositionProvider.
 *
 * @returns CompositionContextValue with phase and dataContext
 *
 * @example
 * ```tsx
 * function MySection() {
 *   const { phase, dataContext } = useCompositionContext()
 *   console.log(`Current phase: ${phase}`)
 * }
 * ```
 */
export function useCompositionContext(): CompositionContextValue {
  return useContext(CompositionContext)
}

// =============================================================================
// usePhaseColorFromContext - Hook to get phase colors from context
// =============================================================================

/**
 * Hook that reads the phase from CompositionContext and returns phase colors.
 * Falls back to 'discovery' phase colors when context is unavailable.
 *
 * @returns PhaseColors object with bg, text, border, ring, accent classes
 *
 * @example
 * ```tsx
 * function MySection() {
 *   const phaseColors = usePhaseColorFromContext()
 *
 *   return (
 *     <div className={cn("border", phaseColors.border)}>
 *       <h2 className={phaseColors.text}>Title</h2>
 *     </div>
 *   )
 * }
 * ```
 */
export function usePhaseColorFromContext(): PhaseColors {
  const { phase } = useCompositionContext()
  return usePhaseColor(phase ?? "discovery")
}

// =============================================================================
// SectionCard - Wrapper component with phase-colored styling
// =============================================================================

/**
 * Props for SectionCard component.
 */
export interface SectionCardProps {
  /** Children to render inside the card */
  children: ReactNode
  /** Phase colors from usePhaseColor or usePhaseColorFromContext */
  phaseColors: PhaseColors
  /** Optional additional className */
  className?: string
  /** Optional data-testid for testing */
  testId?: string
}

/**
 * Wrapper component that provides consistent styling for section content.
 * Applies phase-colored border, rounded corners, card background, and padding.
 *
 * @example
 * ```tsx
 * const phaseColors = usePhaseColorFromContext()
 *
 * <SectionCard phaseColors={phaseColors}>
 *   <p>Section content here</p>
 * </SectionCard>
 * ```
 */
export function SectionCard({
  children,
  phaseColors,
  className,
  testId,
}: SectionCardProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "rounded-lg border bg-card p-4",
        phaseColors.border,
        className
      )}
    >
      {children}
    </div>
  )
}

SectionCard.displayName = "SectionCard"

// =============================================================================
// SectionHeader - Header with icon, title, and optional count badge
// =============================================================================

/**
 * Props for SectionHeader component.
 */
export interface SectionHeaderProps {
  /** Lucide icon element to display */
  icon: ReactNode
  /** Section title text */
  title: string
  /** Optional count to display as badge */
  count?: number
  /** Phase colors from usePhaseColor or usePhaseColorFromContext */
  phaseColors: PhaseColors
  /** Optional additional className */
  className?: string
}

/**
 * Header sub-component with icon, title, and optional count badge.
 * Used at the top of section cards to provide consistent visual hierarchy.
 *
 * @example
 * ```tsx
 * const phaseColors = usePhaseColorFromContext()
 *
 * <SectionHeader
 *   icon={<Search className="h-5 w-5" />}
 *   title="Evidence Board"
 *   count={findings.length}
 *   phaseColors={phaseColors}
 * />
 * ```
 */
export function SectionHeader({
  icon,
  title,
  count,
  phaseColors,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className={phaseColors.text}>{icon}</span>
      <h3 className={cn("text-lg font-semibold", phaseColors.text)}>
        {title}
      </h3>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "px-2 py-0.5 text-xs font-medium rounded-full",
            phaseColors.accent
          )}
        >
          {count}
        </span>
      )}
    </div>
  )
}

SectionHeader.displayName = "SectionHeader"

// =============================================================================
// EmptySectionState - Empty state display component
// =============================================================================

/**
 * Props for EmptySectionState component.
 */
export interface EmptySectionStateProps {
  /** Lucide icon component to display */
  icon: LucideIcon
  /** Message to display below the icon */
  message: string
  /** Optional additional className */
  className?: string
}

/**
 * Empty state component with configurable icon and message.
 * Displays a centered, muted icon with message text below.
 *
 * @example
 * ```tsx
 * import { Inbox } from "lucide-react"
 *
 * <EmptySectionState
 *   icon={Inbox}
 *   message="No requirements captured yet"
 * />
 * ```
 */
export function EmptySectionState({
  icon: Icon,
  message,
  className,
}: EmptySectionStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-8 text-muted-foreground",
        className
      )}
    >
      <Icon className="h-12 w-12 mb-3 opacity-50" />
      <p className="text-sm">{message}</p>
    </div>
  )
}

EmptySectionState.displayName = "EmptySectionState"

// =============================================================================
// Re-exports for convenience
// =============================================================================

export type { PhaseColors }
