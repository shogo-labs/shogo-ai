/**
 * Dynamic App Protocol Types (React Native)
 *
 * Mirrors the web version at apps/web/src/components/app/project/agent/dynamic-app/types.ts
 */

export type ComponentType =
  | 'Row' | 'Column' | 'Grid' | 'Card'
  | 'Tabs' | 'TabPanel' | 'Accordion' | 'AccordionItem' | 'ScrollArea'
  | 'Text' | 'Badge' | 'Image' | 'Icon' | 'Separator' | 'Progress' | 'Skeleton' | 'Alert'
  | 'Table' | 'Metric' | 'Chart' | 'DataList'
  | 'Button' | 'TextField' | 'Select' | 'Checkbox' | 'ChoicePicker'

export interface ComponentDefinition {
  id: string
  component: ComponentType
  child?: string
  children?: string[] | { path: string; templateId: string }
  [key: string]: unknown
}

export interface ActionEvent {
  surfaceId: string
  name: string
  context?: Record<string, unknown>
  timestamp: string
}

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
  models: Array<{ name: string; endpoint: string; fields: string[] }>
}

export type DynamicAppMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataMessage
  | DeleteSurfaceMessage
  | ConfigureApiMessage

export interface ApiModelInfo {
  name: string
  endpoint: string
  fields: string[]
}

export interface SurfaceState {
  surfaceId: string
  title?: string
  theme?: Record<string, string>
  components: Map<string, ComponentDefinition>
  dataModel: Record<string, unknown>
  apiModels?: ApiModelInfo[]
  createdAt: string
  updatedAt: string
}
