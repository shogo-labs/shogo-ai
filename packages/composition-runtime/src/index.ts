/**
 * @shogo/composition-runtime - Composition Rendering System
 *
 * Data-driven UI composition for Shogo apps.
 *
 * This package provides:
 * - Core composition (ComposablePhaseView, SlotLayout)
 * - Component registry system (priority-based cascade resolution)
 * - Property rendering (type-aware display components)
 * - Generic sections (DataGrid, Form, Chart, etc.)
 * - Generic displays (String, Number, Boolean, DateTime, etc.)
 * - UI primitives (Button, Input, Card, etc.)
 * - Phase color system (variants for phase-based styling)
 *
 * Note: Domain-specific displays and sections are NOT included.
 * They should be registered by the consuming application.
 */

// ============================================================================
// Types
// ============================================================================

export type {
  PropertyMetadata,
  DisplayRendererProps,
  ComponentEntry,
  HydratedComponentEntry,
  IComponentRegistry,
  SectionRendererProps,
  // Re-exported from @shogo/state-api
  ComponentEntrySpec,
  ComponentDefinitionEntity,
  RegistryEntity,
  BindingEntity,
  XRendererConfig,
  RenderableComponentProps,
} from "./types"

// ============================================================================
// Utils
// ============================================================================

export { cn } from "./utils/cn"
export {
  phaseColorVariants,
  PHASE_VALUES,
  type PhaseType,
  type PhaseColorVariantsProps,
} from "./utils/variants"

// ============================================================================
// Composition Core
// ============================================================================

export { ComposablePhaseView } from "./composition/ComposablePhaseView"
export type { ComposablePhaseViewProps } from "./composition/ComposablePhaseView"

export { SlotLayout } from "./composition/SlotLayout"
export type {
  SlotLayoutProps,
  SlotDefinition,
  LayoutTemplateData,
} from "./composition/SlotLayout"

export { createPanelContext, type PanelContextValue } from "./composition/createPanelContext"
export {
  getProviderComponent,
  providerImplementationMap,
  type ProviderWrapperProps,
} from "./composition/providerImplementationMap"

// ============================================================================
// Registry
// ============================================================================

export {
  ComponentRegistry,
  createComponentRegistry,
  type ComponentRegistryConfig,
} from "./registry/ComponentRegistry"

export {
  ComponentRegistryProvider,
  useComponentRegistry,
  useHydratedRegistry,
  RegistryHydrationProvider,
  type ComponentRegistryProviderProps,
  type HydratedRegistryResult,
  type ComponentImplementationMap,
  type RegistryHydrationProviderProps,
} from "./registry/ComponentRegistryContext"

export {
  createRegistryFromDomain,
  specToEntry,
} from "./registry/registryFactory"

export { createDefaultRegistry } from "./registry/defaultRegistry"

// ============================================================================
// Rendering
// ============================================================================

export { PropertyRenderer } from "./rendering/PropertyRenderer"
export type { PropertyRendererProps } from "./rendering/PropertyRenderer"

export {
  componentImplementationMap,
  getComponent,
} from "./rendering/implementations"

// ============================================================================
// Displays
// ============================================================================

// Primitive displays
export {
  StringDisplay,
  NumberDisplay,
  BooleanDisplay,
  DateTimeDisplay,
  EmailDisplay,
  UriDisplay,
  EnumBadge,
  ReferenceDisplay,
  ComputedDisplay,
  ArrayDisplay,
  ObjectDisplay,
  StringArrayDisplay,
  LongTextDisplay,
  ImageDisplay,
} from "./displays"

// Visualization displays
export {
  ProgressBar,
  DataCard,
  GraphNode,
  StatusIndicator,
  FilterControl,
  SvgConnection,
} from "./displays/visualization"

// ============================================================================
// Sections
// ============================================================================

export {
  sectionImplementationMap,
  getSectionComponent,
  useDynamicSection,
  DynamicSectionRenderer,
  type DynamicSectionResult,
  type DynamicSectionRendererProps,
} from "./sections/sectionImplementations"

// Generic sections
export { DataGridSection } from "./sections/DataGridSection"
export { FormSection } from "./sections/FormSection"
export type { FormSectionConfig } from "./sections/FormSection"
export { ChartSection } from "./sections/ChartSection"
export { AppBarSection } from "./sections/AppBarSection"
export { SideNavSection } from "./sections/SideNavSection"
export { AppShellSection } from "./sections/AppShellSection"
export { DynamicCompositionSection } from "./sections/DynamicCompositionSection"
export { PlanPreviewSection } from "./sections/PlanPreviewSection"
export { SectionBrowserSection } from "./sections/SectionBrowserSection"

// Section hooks
export {
  useDataGridMetadata,
  useDataGridData,
  useFormMetadata,
  useSideNavData,
} from "./sections/hooks"

// Section utilities
export { deriveUiSchema, filterFormProperties } from "./sections/utils"

// Section contexts
export { AppShellProvider, useAppShell } from "./sections/contexts/AppShellContext"

// Section shared utilities
export {
  SectionCard,
  SectionHeader,
  EmptySectionState,
  CompositionProvider,
  useCompositionContext,
  usePhaseColorFromContext,
  type SectionCardProps,
  type SectionHeaderProps,
  type EmptySectionStateProps,
  type CompositionContextValue,
  type CompositionProviderProps,
} from "./sections/shared"

// ============================================================================
// Hooks
// ============================================================================

export { usePhaseColor, type PhaseColors } from "./hooks/usePhaseColor"
export { useReducedMotion } from "./hooks/useReducedMotion"
export { useFocusManagement } from "./hooks/useFocusManagement"
export { useKeyboardNavigation } from "./hooks/useKeyboardNavigation"

// ============================================================================
// UI Primitives
// ============================================================================

export {
  Button,
  Input,
  Label,
  Textarea,
  Checkbox,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
  DialogClose,
} from "./ui"
