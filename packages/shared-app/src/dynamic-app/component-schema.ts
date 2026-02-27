/**
 * Canvas Component Schema (shared)
 *
 * Lightweight re-export of the component type registry for use by
 * frontend inspector / visual editor UIs. Mirrors the authoritative
 * definitions in packages/agent-runtime/src/canvas-component-schema.ts.
 */

export interface PropDef {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
  enum?: string[]
  default?: unknown
  items?: Record<string, PropDef>
}

export interface ComponentSchema {
  type: string
  category: 'layout' | 'display' | 'data' | 'interactive' | 'extended'
  description: string
  hasChildren: boolean
  props: Record<string, PropDef>
}

const str = (description: string, extra?: Partial<PropDef>): PropDef =>
  ({ type: 'string', description, ...extra })
const num = (description: string, extra?: Partial<PropDef>): PropDef =>
  ({ type: 'number', description, ...extra })
const bool = (description: string, extra?: Partial<PropDef>): PropDef =>
  ({ type: 'boolean', description, ...extra })
const arr = (description: string, items?: Record<string, PropDef>): PropDef =>
  ({ type: 'array', description, items })
const obj = (description: string): PropDef =>
  ({ type: 'object', description })

const GAP_PROP = str('Spacing between children', { enum: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md' })
const ALIGN_PROP = str('Cross-axis alignment', { enum: ['start', 'center', 'end', 'stretch', 'baseline'] })
const JUSTIFY_PROP = str('Main-axis justification', { enum: ['start', 'center', 'end', 'between', 'around', 'evenly'] })
const CLASS_PROP = str('Additional Tailwind class names')
const ACTION_PROP: PropDef = {
  type: 'object',
  description: 'Action dispatched on interaction: { name, mutation? }',
}

export const COMPONENT_SCHEMA: ComponentSchema[] = [
  // Layout
  { type: 'Row', category: 'layout', description: 'Horizontal flex container', hasChildren: true, props: { gap: GAP_PROP, align: ALIGN_PROP, justify: JUSTIFY_PROP, wrap: bool('Allow wrapping'), padding: str('Padding size'), className: CLASS_PROP } },
  { type: 'Column', category: 'layout', description: 'Vertical flex container', hasChildren: true, props: { gap: GAP_PROP, align: ALIGN_PROP, justify: JUSTIFY_PROP, padding: str('Padding size'), className: CLASS_PROP } },
  { type: 'Grid', category: 'layout', description: 'CSS grid container', hasChildren: true, props: { columns: num('Number of columns'), gap: GAP_PROP, className: CLASS_PROP } },
  { type: 'Card', category: 'layout', description: 'Card with optional title and description', hasChildren: true, props: { title: str('Card title'), description: str('Subtitle'), footer: str('Footer text'), className: CLASS_PROP } },
  { type: 'ScrollArea', category: 'layout', description: 'Scrollable container', hasChildren: true, props: { height: str('Container height'), className: CLASS_PROP } },

  // Extended layout
  { type: 'Tabs', category: 'extended', description: 'Tabbed container', hasChildren: true, props: { tabs: arr('Tab definitions', { id: str('Tab ID', { required: true }), label: str('Tab label', { required: true }) }), defaultTab: str('Initially selected tab'), className: CLASS_PROP } },
  { type: 'TabPanel', category: 'extended', description: 'Content for one tab', hasChildren: true, props: { title: str('Tab label', { required: true }), className: CLASS_PROP } },
  { type: 'Accordion', category: 'extended', description: 'Collapsible section container', hasChildren: true, props: { className: CLASS_PROP } },
  { type: 'AccordionItem', category: 'extended', description: 'Single collapsible section', hasChildren: true, props: { title: str('Section header', { required: true }), defaultOpen: bool('Start expanded'), className: CLASS_PROP } },

  // Display
  { type: 'Text', category: 'display', description: 'Text with typography variants', hasChildren: false, props: { text: str('Text content', { required: true }), variant: str('Typography style', { enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'caption', 'code', 'muted', 'large', 'small', 'lead'], default: 'body' }), align: str('Text alignment', { enum: ['left', 'center', 'right'] }), color: str('Tailwind text color suffix'), weight: str('Font weight'), className: CLASS_PROP } },
  { type: 'Badge', category: 'display', description: 'Small label/tag', hasChildren: false, props: { text: str('Badge text'), label: str('Alias for text'), variant: str('Visual style', { enum: ['default', 'secondary', 'destructive', 'outline'], default: 'default' }), className: CLASS_PROP } },
  { type: 'Image', category: 'display', description: 'Image element', hasChildren: false, props: { src: str('Image URL', { required: true }), alt: str('Alt text'), width: str('Width'), height: str('Height'), fit: str('Object-fit', { enum: ['cover', 'contain', 'fill', 'none'], default: 'cover' }), rounded: bool('Rounded corners'), className: CLASS_PROP } },
  { type: 'Icon', category: 'display', description: 'Lucide icon', hasChildren: false, props: { name: str('Icon name', { required: true, enum: ['alert-circle', 'alert-triangle', 'check-circle', 'info', 'mail', 'search', 'star', 'clock', 'calendar', 'map-pin', 'phone', 'globe', 'user', 'heart', 'bookmark', 'download', 'upload', 'settings', 'arrow-right', 'arrow-left', 'plus', 'minus', 'x', 'check', 'edit', 'eye', 'trash', 'copy', 'lock', 'unlock', 'bell', 'zap', 'shield', 'trending-up', 'trending-down', 'dollar-sign', 'home', 'building', 'package'] }), size: str('Icon size', { enum: ['xs', 'sm', 'md', 'lg', 'xl'], default: 'md' }), color: str('Tailwind color suffix'), className: CLASS_PROP } },
  { type: 'Separator', category: 'display', description: 'Dividing line', hasChildren: false, props: { orientation: str('Direction', { enum: ['horizontal', 'vertical'], default: 'horizontal' }), className: CLASS_PROP } },
  { type: 'Progress', category: 'display', description: 'Progress bar', hasChildren: false, props: { value: num('Current value'), max: num('Maximum value'), className: CLASS_PROP } },
  { type: 'Skeleton', category: 'display', description: 'Loading placeholder', hasChildren: false, props: { width: str('Width'), height: str('Height'), rounded: bool('Pill shape'), className: CLASS_PROP } },
  { type: 'Alert', category: 'display', description: 'Callout box', hasChildren: false, props: { title: str('Alert title'), description: str('Alert body'), variant: str('Visual style', { enum: ['default', 'destructive'], default: 'default' }), icon: str('Override icon'), className: CLASS_PROP } },

  // Data
  { type: 'Metric', category: 'data', description: 'Key-value statistic card', hasChildren: false, props: { label: str('Metric label', { required: true }), value: str('Metric value'), unit: str('Unit suffix'), trend: str('Trend direction', { enum: ['up', 'down', 'neutral'] }), trendValue: str('Trend amount'), description: str('Description below value'), className: CLASS_PROP } },
  { type: 'Table', category: 'data', description: 'Data table', hasChildren: false, props: { columns: arr('Column definitions', { key: str('Data key', { required: true }), label: str('Column header', { required: true }), align: str('Alignment', { enum: ['left', 'center', 'right'] }), width: str('Column width') }), rows: arr('Row data array'), striped: bool('Alternating rows'), compact: bool('Smaller padding'), className: CLASS_PROP } },
  { type: 'Chart', category: 'data', description: 'Simple chart', hasChildren: false, props: { type: str('Chart type', { enum: ['bar', 'horizontalBar', 'progress'], default: 'bar' }), data: arr('Data points', { label: str('Point label', { required: true }), value: num('Point value', { required: true }), color: str('CSS color') }), title: str('Chart title'), height: num('Chart height in px'), className: CLASS_PROP } },
  { type: 'DataList', category: 'data', description: 'Repeating template container', hasChildren: true, props: { emptyText: str('Empty state text'), className: CLASS_PROP } },

  // Interactive
  { type: 'Button', category: 'interactive', description: 'Clickable button', hasChildren: false, props: { label: str('Button text', { required: true }), text: str('Alias for label'), variant: str('Visual style', { enum: ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'], default: 'default' }), size: str('Button size', { enum: ['default', 'sm', 'lg', 'icon'], default: 'default' }), disabled: bool('Disable button'), action: ACTION_PROP, className: CLASS_PROP } },
  { type: 'TextField', category: 'interactive', description: 'Text input', hasChildren: false, props: { label: str('Field label'), placeholder: str('Placeholder'), value: str('Initial value'), type: str('Input type', { enum: ['text', 'email', 'password', 'number', 'url', 'tel'], default: 'text' }), disabled: bool('Disable field'), action: ACTION_PROP, dataPath: str('JSON Pointer for data binding'), className: CLASS_PROP } },
  { type: 'Select', category: 'interactive', description: 'Dropdown select', hasChildren: false, props: { label: str('Field label'), options: arr('Options', { label: str('Display text', { required: true }), value: str('Option value', { required: true }) }), value: str('Selected value'), placeholder: str('Placeholder'), disabled: bool('Disable select'), action: ACTION_PROP, dataPath: str('JSON Pointer for data binding'), className: CLASS_PROP } },
  { type: 'Checkbox', category: 'interactive', description: 'Toggle checkbox', hasChildren: false, props: { label: str('Checkbox label'), checked: bool('Initial state'), disabled: bool('Disable checkbox'), action: ACTION_PROP, dataPath: str('JSON Pointer for data binding'), className: CLASS_PROP } },
  { type: 'ChoicePicker', category: 'interactive', description: 'Chip/radio group', hasChildren: false, props: { label: str('Group label'), options: arr('Options', { label: str('Display text', { required: true }), value: str('Option value', { required: true }) }), value: str('Selected value(s)'), multiple: bool('Allow multiple'), variant: str('Visual style', { enum: ['radio', 'chip'], default: 'chip' }), action: ACTION_PROP, dataPath: str('JSON Pointer for data binding'), className: CLASS_PROP } },
]

const schemaByType = new Map<string, ComponentSchema>()
for (const s of COMPONENT_SCHEMA) {
  schemaByType.set(s.type, s)
}

export function getComponentSchema(type: string): ComponentSchema | undefined {
  return schemaByType.get(type)
}

export const COMPONENT_CATEGORIES = ['layout', 'extended', 'display', 'data', 'interactive'] as const

export function getComponentsByCategory(category: string): ComponentSchema[] {
  return COMPONENT_SCHEMA.filter((s) => s.category === category)
}
