/**
 * Dynamic App Protocol Types
 *
 * Defines the JSON message protocol for agent-driven UI rendering.
 * Agents send these messages to create, update, and remove UI surfaces
 * that are rendered as shadcn components on the frontend canvas.
 *
 * Inspired by Google's A2UI protocol, simplified for Shogo agent builder.
 */

// ---------------------------------------------------------------------------
// Data Binding
// ---------------------------------------------------------------------------

/** A value that can be a literal, a JSON Pointer path, or an API endpoint binding */
export type DynamicValue<T = string> =
  | T
  | { path: string }
  | { api: string; params?: Record<string, unknown>; refreshInterval?: number }

// ---------------------------------------------------------------------------
// Component Definitions
// ---------------------------------------------------------------------------

export type ComponentType =
  // Layout
  | 'Row'
  | 'Column'
  | 'Grid'
  | 'Card'
  | 'Tabs'
  | 'TabPanel'
  | 'Accordion'
  | 'AccordionItem'
  | 'ScrollArea'
  // Display
  | 'Text'
  | 'Badge'
  | 'Image'
  | 'Icon'
  | 'Separator'
  | 'Progress'
  | 'Skeleton'
  | 'Alert'
  // Data
  | 'Table'
  | 'Metric'
  | 'Chart'
  | 'DataList'
  // Interactive
  | 'Button'
  | 'TextField'
  | 'Select'
  | 'Checkbox'
  | 'ChoicePicker'

export interface ComponentDefinition {
  id: string
  component: ComponentType
  /** Single child reference */
  child?: string
  /** Array of child component IDs */
  children?: string[] | { path: string; templateId: string }
  /** Component-specific props (varies by component type) */
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Action Events (user interaction -> agent)
// ---------------------------------------------------------------------------

export interface ActionEvent {
  surfaceId: string
  name: string
  context?: Record<string, unknown>
  timestamp: string
}

// ---------------------------------------------------------------------------
// Protocol Messages (server -> client via SSE)
// ---------------------------------------------------------------------------

export interface CreateSurfaceMessage {
  type: 'createSurface'
  surfaceId: string
  title?: string
  theme?: Record<string, string>
}

export interface UpdateComponentsMessage {
  type: 'updateComponents'
  surfaceId: string
  components: ComponentDefinition[]
}

export interface UpdateDataMessage {
  type: 'updateData'
  surfaceId: string
  /** JSON Pointer path, defaults to "/" (replace entire model) */
  path?: string
  value: unknown
}

export interface DeleteSurfaceMessage {
  type: 'deleteSurface'
  surfaceId: string
}

export interface ConfigureApiMessage {
  type: 'configureApi'
  surfaceId: string
  models: Array<{
    name: string
    endpoint: string
    fields: string[]
  }>
}

export type DynamicAppMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataMessage
  | DeleteSurfaceMessage
  | ConfigureApiMessage

// ---------------------------------------------------------------------------
// Surface State (maintained by the state manager)
// ---------------------------------------------------------------------------

export interface SurfaceState {
  surfaceId: string
  title?: string
  theme?: Record<string, string>
  components: Map<string, ComponentDefinition>
  dataModel: Record<string, unknown>
  /** Persisted API model definitions so runtimes can be restored after restart */
  apiModels?: Array<{ name: string; fields: Array<{ name: string; type: string; optional?: boolean; default?: unknown; unique?: boolean }> }>
  createdAt: string
  updatedAt: string
}

export interface DynamicAppState {
  surfaces: Record<string, SurfaceState>
}
