/**
 * Component Rendering System - Extended
 *
 * Re-exports from @shogo/composition-runtime plus domain-specific extensions.
 *
 * This file provides a unified API for the Shogo Studio application,
 * combining base components from composition-runtime with domain-specific
 * renderers and sections.
 */

// ============================================================================
// Re-export everything from @shogo/composition-runtime
// ============================================================================

export {
  // Types
  type PropertyMetadata,
  type DisplayRendererProps,
  type ComponentEntry,
  type HydratedComponentEntry,
  type IComponentRegistry,
  type SectionRendererProps,
  type ComponentEntrySpec,
  type ComponentDefinitionEntity,
  type RegistryEntity,
  type BindingEntity,
  type XRendererConfig,
  type RenderableComponentProps,

  // Utils
  cn,
  phaseColorVariants,
  PHASE_VALUES,
  type PhaseType,
  type PhaseColorVariantsProps,

  // Composition Core
  ComposablePhaseView,
  type ComposablePhaseViewProps,
  SlotLayout,
  type SlotLayoutProps,
  type SlotDefinition,
  type LayoutTemplateData,
  createPanelContext,
  type PanelContextValue,
  getProviderComponent,
  providerImplementationMap,
  type ProviderWrapperProps,

  // Registry
  ComponentRegistry,
  createComponentRegistry,
  type ComponentRegistryConfig,
  ComponentRegistryProvider,
  useComponentRegistry,
  useHydratedRegistry,
  RegistryHydrationProvider,
  type ComponentRegistryProviderProps,
  type HydratedRegistryResult,
  type ComponentImplementationMap,
  type RegistryHydrationProviderProps,
  createRegistryFromDomain,
  specToEntry,
  createDefaultRegistry,

  // PropertyRenderer
  PropertyRenderer,
  type PropertyRendererProps,

  // Primitive displays
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

  // Visualization displays
  ProgressBar,
  DataCard,
  GraphNode,
  StatusIndicator,
  FilterControl,
  SvgConnection,

  // Base sections
  DataGridSection,
  FormSection,
  type FormSectionConfig,
  ChartSection,
  AppBarSection,
  SideNavSection,
  AppShellSection,
  DynamicCompositionSection,
  PlanPreviewSection,
  SectionBrowserSection,

  // Section hooks
  useDataGridMetadata,
  useDataGridData,
  useFormMetadata,
  useSideNavData,

  // Section utilities
  deriveUiSchema,
  filterFormProperties,

  // Section contexts
  AppShellProvider,
  useAppShell,

  // Section shared utilities
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

  // Hooks
  usePhaseColor,
  type PhaseColors,
  useReducedMotion,
  useFocusManagement,
  useKeyboardNavigation,

  // UI Primitives
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
} from "@shogo/composition-runtime"

// ============================================================================
// Extended implementations (local - includes domain-specific components)
// ============================================================================

// Component implementations (extended with domain renderers)
export { componentImplementationMap, getComponent } from "./implementations"

// Section implementations (extended with feature-specific sections)
export {
  sectionImplementationMap,
  getSectionComponent,
  useDynamicSection,
  DynamicSectionRenderer,
  type DynamicSectionResult,
  type DynamicSectionRendererProps,
} from "./sectionImplementations"

// ============================================================================
// Domain-specific exports (local only)
// ============================================================================

// Domain-specific renderers
export * from "./displays/domain"

// Studio registry factory (includes domain renderers)
export { createStudioRegistry } from "./studioRegistry"

// Seed data (task-dcb-005)
export {
  seedComponentBuilderData,
  COMPONENT_DEFINITIONS,
  REGISTRY_DEFINITIONS,
  DEFAULT_BINDINGS,
  STUDIO_BINDINGS,
} from "./seedData"

// AppShell context extensions
export { useAppShellRequired } from "./contexts"
export type { NavItem, AppShellContextValue } from "./contexts"
