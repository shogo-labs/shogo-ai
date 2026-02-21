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

/** A value that can be either a literal or a JSON Pointer path into the data model */
export type DynamicValue<T = string> = T | { path: string }

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

export type DynamicAppMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataMessage
  | DeleteSurfaceMessage

// ---------------------------------------------------------------------------
// Surface State (maintained by the state manager)
// ---------------------------------------------------------------------------

export interface SurfaceState {
  surfaceId: string
  title?: string
  theme?: Record<string, string>
  components: Map<string, ComponentDefinition>
  dataModel: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface DynamicAppState {
  surfaces: Record<string, SurfaceState>
}
