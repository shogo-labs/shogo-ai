// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas Component Schema
 *
 * Authoritative registry of every canvas component type, its category,
 * accepted props, and allowed values.  Used by:
 *   - canvas_components  (discovery tool — agents query what's available)
 *   - canvas_update      (validation — lint components before rendering)
 */

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface PropDef {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object'
  description: string
  required?: boolean
  enum?: string[]
  default?: unknown
  /** When type is 'array', describes the shape of each element */
  items?: Record<string, PropDef>
}

export interface ComponentSchema {
  type: string
  category: 'layout' | 'display' | 'data' | 'interactive' | 'extended'
  description: string
  hasChildren: boolean
  props: Record<string, PropDef>
}

// Shorthand builders
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

// Reusable prop fragments
const GAP_PROP = str('Spacing between children', { enum: ['none', 'xs', 'sm', 'md', 'lg', 'xl'], default: 'md' })
const ALIGN_PROP = str('Cross-axis alignment', { enum: ['start', 'center', 'end', 'stretch', 'baseline'] })
const JUSTIFY_PROP = str('Main-axis justification', { enum: ['start', 'center', 'end', 'between', 'around', 'evenly'] })
const CLASS_PROP = str('Additional Tailwind class names')
const ACTION_PROP: PropDef = {
  type: 'object',
  description: `Action dispatched on interaction: { name: string, context?: object }.
For CRUD mutations: { name: "add", mutation: { endpoint: "/api/items", method: "POST", body: { ... } } }
For opening external URLs: { name: "open_link", mutation: { endpoint: "https://example.com" OR { path: "url" }, method: "OPEN" } }
  method "OPEN" opens the resolved endpoint in a new browser tab. Use this when you have per-item URLs in a DataList (e.g. Airbnb listing URLs).
Use with canvas_action_wait to receive the event for non-mutation actions.`,
}

// ---------------------------------------------------------------------------
// Full component catalog
// ---------------------------------------------------------------------------

export const CANVAS_COMPONENT_SCHEMA: ComponentSchema[] = [
  // ---- Layout ----
  {
    type: 'Row',
    category: 'layout',
    description: 'Horizontal flex container. Places children side by side.',
    hasChildren: true,
    props: { gap: GAP_PROP, align: ALIGN_PROP, justify: JUSTIFY_PROP, wrap: bool('Allow wrapping to next line'), padding: str('Padding size (e.g. "4")'), className: CLASS_PROP },
  },
  {
    type: 'Column',
    category: 'layout',
    description: 'Vertical flex container. Stacks children top to bottom.',
    hasChildren: true,
    props: { gap: GAP_PROP, align: ALIGN_PROP, justify: JUSTIFY_PROP, padding: str('Padding size (e.g. "4")'), className: CLASS_PROP },
  },
  {
    type: 'Grid',
    category: 'layout',
    description: 'CSS grid container with configurable columns.',
    hasChildren: true,
    props: { columns: num('Number of columns (default 2)'), gap: GAP_PROP, className: CLASS_PROP },
  },
  {
    type: 'Card',
    category: 'layout',
    description: 'Shadcn Card with optional title, description, and footer. Wraps children in CardContent.',
    hasChildren: true,
    props: { title: str('Card title'), description: str('Subtitle below the title'), footer: str('Footer text'), className: CLASS_PROP },
  },
  {
    type: 'ScrollArea',
    category: 'layout',
    description: 'Scrollable container with a fixed height.',
    hasChildren: true,
    props: { height: str('Container height, e.g. "400px" or 300 (number = px). Omit to fill available space.'), className: CLASS_PROP },
  },

  // ---- Extended layout ----
  {
    type: 'Tabs',
    category: 'extended',
    description: 'Tabbed container. Put one TabPanel child per tab with a "title" prop for the tab label. Optionally override with explicit "tabs" prop.',
    hasChildren: true,
    props: {
      tabs: arr('Optional explicit tab definitions: [{ id, label }]. If omitted, tabs are auto-derived from TabPanel children\'s "title" props.', { id: str('Tab ID', { required: true }), label: str('Tab display label', { required: true }) }),
      defaultTab: str('ID of the initially selected tab'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'TabPanel',
    category: 'extended',
    description: 'Content wrapper for one tab inside a Tabs component. Set "title" as the tab label shown in the tab strip.',
    hasChildren: true,
    props: { title: str('Tab label displayed in the tab strip', { required: true }), className: CLASS_PROP },
  },
  {
    type: 'Accordion',
    category: 'extended',
    description: 'Collapsible section container. Children should be AccordionItem components.',
    hasChildren: true,
    props: { className: CLASS_PROP },
  },
  {
    type: 'AccordionItem',
    category: 'extended',
    description: 'A single collapsible section inside an Accordion.',
    hasChildren: true,
    props: { title: str('Section header text', { required: true }), defaultOpen: bool('Start expanded'), className: CLASS_PROP },
  },

  // ---- Display ----
  {
    type: 'Text',
    category: 'display',
    description: 'Renders text with typography variants. Supports data binding via { path }.',
    hasChildren: false,
    props: {
      text: str('The text content (or { path: "/..." } for data binding)', { required: true }),
      variant: str('Typography style', { enum: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'caption', 'code', 'muted', 'large', 'small', 'lead'], default: 'body' }),
      align: str('Text alignment', { enum: ['left', 'center', 'right'] }),
      color: str('Tailwind text color suffix, e.g. "muted-foreground"'),
      weight: str('Font weight, e.g. "bold", "medium"'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Badge',
    category: 'display',
    description: 'Small label/tag. Good for status indicators, categories.',
    hasChildren: false,
    props: {
      text: str('Badge text (or use "label")'),
      label: str('Alias for text'),
      variant: str('Visual style', { enum: ['default', 'secondary', 'destructive', 'outline'], default: 'default' }),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Image',
    category: 'display',
    description: 'Renders an <img> element.',
    hasChildren: false,
    props: {
      src: str('Image URL', { required: true }),
      alt: str('Alt text'),
      width: str('Width (px number or CSS string)'),
      height: str('Height (px number or CSS string)'),
      fit: str('object-fit value', { enum: ['cover', 'contain', 'fill', 'none'], default: 'cover' }),
      rounded: bool('Apply rounded corners'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Icon',
    category: 'display',
    description: 'Lucide icon by name.',
    hasChildren: false,
    props: {
      name: str('Icon name (kebab-case)', {
        required: true,
        enum: [
          'alert-circle', 'alert-triangle', 'check-circle', 'info', 'mail', 'search',
          'star', 'clock', 'calendar', 'map-pin', 'phone', 'globe', 'user', 'heart',
          'bookmark', 'download', 'upload', 'settings', 'arrow-right', 'arrow-left',
          'arrow-up', 'arrow-down', 'chevron-right', 'chevron-left', 'chevron-up',
          'chevron-down', 'plus', 'minus', 'x', 'check', 'loader', 'external-link',
          'copy', 'trash', 'edit', 'eye', 'eye-off', 'lock', 'unlock', 'bell',
          'bell-off', 'zap', 'shield', 'trending-up', 'trending-down', 'dollar-sign',
          'plane', 'car', 'home', 'building', 'package',
        ],
      }),
      size: str('Icon size', { enum: ['xs', 'sm', 'md', 'lg', 'xl'], default: 'md' }),
      color: str('Tailwind color suffix'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Separator',
    category: 'display',
    description: 'A horizontal or vertical dividing line.',
    hasChildren: false,
    props: { orientation: str('Direction', { enum: ['horizontal', 'vertical'], default: 'horizontal' }), className: CLASS_PROP },
  },
  {
    type: 'Progress',
    category: 'display',
    description: 'Progress bar.',
    hasChildren: false,
    props: { value: num('Current value'), max: num('Maximum value (default 100)'), className: CLASS_PROP },
  },
  {
    type: 'Skeleton',
    category: 'display',
    description: 'Loading placeholder.',
    hasChildren: false,
    props: { width: str('Width'), height: str('Height (default "20px")'), rounded: bool('Use pill shape'), className: CLASS_PROP },
  },
  {
    type: 'Alert',
    category: 'display',
    description: 'Callout box with icon, title, and description.',
    hasChildren: false,
    props: {
      title: str('Alert title'),
      description: str('Alert body text'),
      variant: str('Visual style', { enum: ['default', 'destructive'], default: 'default' }),
      icon: str('Override icon name (uses lucide-react names)'),
      className: CLASS_PROP,
    },
  },

  // ---- Data ----
  {
    type: 'Metric',
    category: 'data',
    description: 'Key-value statistic card with optional trend indicator. Values can use { path: "/..." } bindings populated via canvas_api_query.',
    hasChildren: false,
    props: {
      label: str('Metric label', { required: true }),
      value: str('Metric value (string or number), or use { path: "/summary/total" } to bind to data model. Use canvas_api_hooks with recompute action to auto-update bound values after mutations.'),
      unit: str('Unit suffix (e.g. "USD", "%")'),
      trend: str('Trend direction', { enum: ['up', 'down', 'neutral'] }),
      trendValue: str('Trend amount (e.g. "+12%")'),
      trendSentiment: str('Override the color: "positive" = green, "negative" = red, "neutral" = gray. By default up=green, down=red. Use this when up is bad (e.g. traffic delay, error count).', { enum: ['positive', 'negative', 'neutral'] }),
      description: str('Small description below the value'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Table',
    category: 'data',
    description: 'Data table with columns and rows.',
    hasChildren: false,
    props: {
      columns: arr('Column definitions: [{ key, label, align?, width? }]', {
        key: str('Data key', { required: true }),
        label: str('Column header', { required: true }),
        align: str('Cell alignment', { enum: ['left', 'center', 'right'] }),
        width: str('Column width CSS'),
      }),
      rows: arr('Row data array, or use { path: "/tasks" } to bind to data model. Populate via canvas_api_query with dataPath.'),
      striped: bool('Alternating row backgrounds'),
      compact: bool('Smaller padding'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Chart',
    category: 'data',
    description: `Chart component supporting multiple visualization types.

Use \`bar\` for comparisons across categories, \`horizontalBar\` for long labels, \`progress\` for percentage-based bars.
Use \`line\` for trends over time, \`area\` for filled trend lines.
Use \`pie\` for proportional breakdowns, \`donut\` for proportional breakdowns with a center label area.

All types accept the same \`data\` array format: [{ label, value, color? }].
For pie/donut, each item becomes a slice. For line/area, items are plotted left-to-right in order.`,
    hasChildren: false,
    props: {
      type: str('Chart type', { enum: ['bar', 'horizontalBar', 'progress', 'line', 'area', 'pie', 'donut'], default: 'bar' }),
      data: arr('Data points array, or use { path: "/metrics" } to bind to data model. Populate via canvas_api_query with dataPath.', {
        label: str('Point label', { required: true }),
        value: num('Point value', { required: true }),
        color: str('CSS color override'),
      }),
      title: str('Chart title'),
      height: num('Chart height in px (default 200)'),
      showLegend: bool('Show a legend below the chart (default true for pie/donut, false for others)'),
      curved: bool('Use smooth curved lines instead of straight segments (line/area only, default false)'),
      showDataPoints: bool('Show dots at each data point (line/area only, default true)'),
      innerRadius: num('Inner radius for donut charts in px (donut only, default 60)'),
      colors: arr('Custom color palette as hex strings. Overrides the default palette.'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'DataList',
    category: 'data',
    description: `Repeating container that renders a template component once for each item in a data array.

To use DataList with data binding, set "children" to an object with "path" and "templateId":
  { "children": { "path": "/tasks", "templateId": "task_item" } }

The template component and all its descendants are rendered once per item. Inside the template,
use { "path": "fieldName" } (NO leading slash) to bind to the current item's fields:
  { "id": "task_item", "component": "Text", "text": { "path": "title" } }
This resolves "title" from each item, NOT from the root data model.

Full example:
  { "id": "list", "component": "DataList", "children": { "path": "/tasks", "templateId": "task_row" } }
  { "id": "task_row", "component": "Row", "children": ["task_title", "delete_btn"], "align": "center" }
  { "id": "task_title", "component": "Text", "text": { "path": "title" } }
  { "id": "delete_btn", "component": "Button", "label": "Delete", "variant": "destructive", "size": "sm",
    "action": { "name": "delete", "mutation": { "endpoint": "/api/tasks/:id", "method": "DELETE", "params": { "id": { "path": "id" } } } } }

Search & filter: set filterPath to a JSON Pointer where a TextField writes its value, and filterFields to the item fields to search.
The DataList will client-side filter items in real time (case-insensitive substring match).
  { "id": "search", "component": "TextField", "placeholder": "Search...", "dataPath": "/searchTerm" }
  { "id": "list", "component": "DataList", "children": { "path": "/tasks", "templateId": "row" },
    "filterPath": "/searchTerm", "filterFields": ["title", "description"] }

Exact-value filtering with "where": show only items where fields match specific values. Ideal for Kanban boards and pipeline columns where multiple DataLists share the same data path but display different subsets.
  { "id": "new_col", "component": "DataList", "children": { "path": "/leads", "templateId": "lead_card" },
    "where": { "stage": "new" } }
  { "id": "qualified_col", "component": "DataList", "children": { "path": "/leads", "templateId": "lead_card" },
    "where": { "stage": "qualified" } }`,
    hasChildren: true,
    props: {
      emptyText: str('Text to show when empty'),
      where: { type: 'object', description: 'Exact-value filter object. Only items where every key matches the given value are shown. Example: { "stage": "new" }. Ideal for Kanban/pipeline columns sharing the same data path.' },
      filterPath: str('JSON Pointer to a search term in the data model (e.g. "/searchTerm"). When set with filterFields, items are filtered client-side in real time.'),
      filterFields: arr('Item fields to match against the search term (e.g. ["title", "description"]). Used with filterPath for client-side filtering.'),
      className: CLASS_PROP,
    },
  },

  // ---- Interactive ----
  {
    type: 'Button',
    category: 'interactive',
    description: `Clickable button. All behavior is driven through the "action" prop with a mutation:
  - CRUD: { name: "add", mutation: { endpoint: "/api/items", method: "POST", body: { ... } } }
  - Open external URL: { name: "view", mutation: { endpoint: "https://example.com", method: "OPEN" } }
    In a DataList template, bind the URL: mutation: { endpoint: { path: "url" }, method: "OPEN" }
    method "OPEN" opens the URL in a new browser tab — use it for Airbnb links, Google Maps, etc.`,
    hasChildren: false,
    props: {
      label: str('Button text', { required: true }),
      text: str('Alias for label'),
      variant: str('Visual style', { enum: ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'], default: 'default' }),
      size: str('Button size', { enum: ['default', 'sm', 'lg', 'icon'], default: 'default' }),
      disabled: bool('Disable the button'),
      action: ACTION_PROP,
      className: CLASS_PROP,
    },
  },
  {
    type: 'TextField',
    category: 'interactive',
    description: `Text input with optional label. Dispatches action on Enter.
Set "dataPath" to write user input to the data model as they type. Then reference
that path in a Button mutation body: { title: { path: "/newTitle" } }.
Example: { id: "input", component: "TextField", placeholder: "Title...", dataPath: "/newTitle" }`,
    hasChildren: false,
    props: {
      label: str('Field label'),
      placeholder: str('Placeholder text'),
      value: str('Initial value'),
      type: str('Input type', { enum: ['text', 'email', 'password', 'number', 'url', 'tel'], default: 'text' }),
      disabled: bool('Disable the field'),
      action: ACTION_PROP,
      dataPath: str('JSON Pointer path — writes user input to the data model in real-time (e.g. "/newTitle")'),
      debounceMs: num('Debounce delay in ms before writing to data model (useful for search inputs, e.g. 300)'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Select',
    category: 'interactive',
    description: `Dropdown select. Dispatches action on change.
Set "dataPath" to write the selected value to the data model. Then reference
that path in a Button mutation body: { priority: { path: "/newPriority" } }.`,
    hasChildren: false,
    props: {
      label: str('Field label'),
      options: arr('Options: [{ label, value }]', {
        label: str('Display text', { required: true }),
        value: str('Option value', { required: true }),
      }),
      value: str('Initially selected value'),
      placeholder: str('Placeholder option text'),
      disabled: bool('Disable the select'),
      action: ACTION_PROP,
      dataPath: str('JSON Pointer path — writes selected value to the data model (e.g. "/newPriority")'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Checkbox',
    category: 'interactive',
    description: 'Toggle checkbox with label. Dispatches action on change.',
    hasChildren: false,
    props: {
      label: str('Checkbox label'),
      checked: bool('Initial checked state'),
      disabled: bool('Disable the checkbox'),
      action: ACTION_PROP,
      dataPath: str('JSON Pointer for two-way data binding'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'ChoicePicker',
    category: 'interactive',
    description: 'Chip/radio button group for single or multi-select.',
    hasChildren: false,
    props: {
      label: str('Group label'),
      options: arr('Options: [{ label, value }]', {
        label: str('Display text', { required: true }),
        value: str('Option value', { required: true }),
      }),
      value: str('Initially selected value(s)'),
      multiple: bool('Allow multiple selections'),
      variant: str('Visual style', { enum: ['radio', 'chip'], default: 'chip' }),
      action: ACTION_PROP,
      dataPath: str('JSON Pointer for two-way data binding'),
      className: CLASS_PROP,
    },
  },
]

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

const schemaByType = new Map<string, ComponentSchema>()
for (const s of CANVAS_COMPONENT_SCHEMA) {
  schemaByType.set(s.type, s)
}

export const VALID_COMPONENT_TYPES = new Set(CANVAS_COMPONENT_SCHEMA.map((s) => s.type))

export function getComponentSchema(type: string): ComponentSchema | undefined {
  return schemaByType.get(type)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface LintMessage {
  severity: 'error' | 'warning'
  componentId: string
  message: string
}

/**
 * Validate an array of component definitions.
 * Returns an array of lint messages (empty = all good).
 */
export function lintComponents(components: Array<{ id?: string; component?: string; [k: string]: unknown }>): LintMessage[] {
  const messages: LintMessage[] = []

  for (const comp of components) {
    const cid = String(comp.id ?? '(no id)')

    if (!comp.id) {
      messages.push({ severity: 'error', componentId: cid, message: 'Component is missing required "id" field.' })
      continue
    }

    if (!comp.component) {
      messages.push({ severity: 'error', componentId: cid, message: 'Component is missing required "component" field (the type name, e.g. "Card", "Text").' })
      continue
    }

    const schema = getComponentSchema(comp.component)
    if (!schema) {
      const suggestion = findClosestType(comp.component)
      const hint = suggestion ? ` Did you mean "${suggestion}"?` : ''
      messages.push({
        severity: 'error',
        componentId: cid,
        message: `Unknown component type "${comp.component}".${hint} Valid types: ${[...VALID_COMPONENT_TYPES].join(', ')}.`,
      })
      continue
    }

    // Children: if schema says hasChildren but neither children nor child is provided
    if (schema.hasChildren && !comp.children && !comp.child) {
      messages.push({
        severity: 'error',
        componentId: cid,
        message: `"${schema.type}" supports children but neither "children" (array of IDs) nor "child" (single ID) was provided. The component will render empty. Add children or child to fix.`,
      })
    }

    // Required props
    for (const [propName, propDef] of Object.entries(schema.props)) {
      if (propDef.required && comp[propName] === undefined) {
        messages.push({
          severity: 'error',
          componentId: cid,
          message: `"${schema.type}" is missing required prop "${propName}" (${propDef.description}). The component will not render correctly without it.`,
        })
      }
    }

    // Enum validation — error: the value won't be applied, component will use default or break
    for (const [propName, propDef] of Object.entries(schema.props)) {
      const val = comp[propName]
      if (val !== undefined && propDef.enum && typeof val === 'string') {
        if (!propDef.enum.includes(val)) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `"${schema.type}.${propName}" has value "${val}" which is not one of: ${propDef.enum.join(', ')}. The component will ignore this value. Fix by using a valid option.`,
          })
        }
      }
    }

    // Children/child on components that don't support them
    if (!schema.hasChildren) {
      if (comp.children !== undefined) {
        messages.push({
          severity: 'error',
          componentId: cid,
          message: `"${schema.type}" does not support children, but "children" was provided. It will be ignored. Remove "children" or use a container component (Column, Row, Card) instead.`,
        })
      }
      if (comp.child !== undefined) {
        messages.push({
          severity: 'error',
          componentId: cid,
          message: `"${schema.type}" does not support children, but "child" was provided. It will be ignored. Remove "child" or use a container component (Column, Row, Card) instead.`,
        })
      }
    }

    // Button without any action or href — the button will do nothing when clicked
    if (comp.component === 'Button' && !comp.action && !comp.href) {
      messages.push({
        severity: 'warning',
        componentId: cid,
        message: `Button has no action or href — it will do nothing when clicked. ` +
          `Fix: add an action prop with a mutation. ` +
          `For external links: action: { name: "open", mutation: { endpoint: "https://example.com", method: "OPEN" } }. ` +
          `For per-item URLs in a DataList: action: { name: "open", mutation: { endpoint: { path: "url" }, method: "OPEN" } }.`,
      })
    }

    // Button action.mutation validation
    if (comp.component === 'Button' && comp.action) {
      const action = comp.action as Record<string, unknown>
      if (!action.name) {
        messages.push({
          severity: 'error',
          componentId: cid,
          message: `Button action is missing "name". Every action needs a name (e.g. { name: "add_item", mutation: { ... } }).`,
        })
      }
      if (!action.mutation) {
        const name = String(action.name ?? '').toLowerCase()
        const isLikelyCrud = /^(add|create|save|delete|remove|update|edit|mark|toggle|patch|cancel|book|reserve)/.test(name)
        messages.push({
          severity: isLikelyCrud ? 'error' : 'warning',
          componentId: cid,
          message: `Button "${cid}" has action.name "${action.name}" but NO mutation. Without mutation, this button does NOTHING when clicked. Add: mutation: { endpoint: "/api/...", method: "POST|PATCH|DELETE", body?: {...} }`,
        })
      }
      if (action.mutation) {
        const mutation = action.mutation as Record<string, unknown>
        const endpoint = mutation.endpoint
        const method = mutation.method
        if (!endpoint) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `Button action.mutation is missing "endpoint". Provide the API path (e.g. "/api/items") or a URL for method "OPEN".`,
          })
        }
        if (!method) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `Button action.mutation is missing "method". Use one of: POST, PATCH, DELETE (CRUD), or OPEN (external URL in new tab).`,
          })
        } else if (typeof method === 'string' && !VALID_MUTATION_METHODS.has(method.toUpperCase())) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `Button action.mutation.method "${method}" is not valid. Use one of: POST, PATCH, DELETE, OPEN.`,
          })
        }
        const endpointStr = typeof endpoint === 'string' ? endpoint : ''
        const pathPart = endpointStr.replace(/^https?:\/\/[^/]*/, '')
        if (pathPart.includes(':') && !mutation.params) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `Button mutation endpoint "${endpoint}" has parameter placeholders (e.g. :id) but no "params" defined. Add params: { id: { path: "id" } } to resolve :id from the current item data.`,
          })
        }
      }
    }

    // dataPath prop validation (must be a JSON Pointer starting with /)
    if (typeof comp.dataPath === 'string' && comp.dataPath && !comp.dataPath.startsWith('/')) {
      messages.push({
        severity: 'error',
        componentId: cid,
        message: `"${schema.type}" has dataPath "${comp.dataPath}" which doesn't start with "/". dataPath must be a JSON Pointer (e.g. "/newTitle"). Add a leading "/" to fix.`,
      })
    }

    // filterPath prop validation (must be a JSON Pointer starting with /)
    if (typeof comp.filterPath === 'string' && comp.filterPath && !comp.filterPath.startsWith('/')) {
      messages.push({
        severity: 'error',
        componentId: cid,
        message: `"${schema.type}" has filterPath "${comp.filterPath}" which doesn't start with "/". filterPath must be a JSON Pointer (e.g. "/searchTerm"). Add a leading "/" to fix.`,
      })
    }

    // Unknown props — error: the prop is silently ignored, so the intended behavior won't work
    // Always include children/child in knownKeys; the explicit hasChildren check above gives a better error
    const knownKeys = new Set(['id', 'component', 'children', 'child', ...Object.keys(schema.props)])
    for (const key of Object.keys(comp)) {
      if (!knownKeys.has(key)) {
        messages.push({
          severity: 'error',
          componentId: cid,
          message: `"${schema.type}" received unknown prop "${key}". This prop will be ignored. Known props: ${[...knownKeys].join(', ')}. Use canvas_components to look up valid props.`,
        })
      }
    }
  }

  // Check for root component
  if (components.length > 0 && !components.some((c) => c.id === 'root')) {
    messages.push({
      severity: 'error',
      componentId: '(tree)',
      message: 'No component with id "root" found. The component tree needs a "root" node to render. Nothing will display without it.',
    })
  }

  // ---- Cross-component validations (need full component map) ----
  const compById = new Map(components.filter((c) => c.id).map((c) => [c.id, c]))

  // Children reference validation: check that referenced IDs exist
  for (const comp of components) {
    if (!comp.id) continue
    const cid = String(comp.id)

    if (Array.isArray(comp.children)) {
      for (const childId of comp.children as unknown[]) {
        if (typeof childId === 'string' && !compById.has(childId)) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `Children references id "${childId}" which does not exist in the component set. Add a component with id "${childId}" or remove it from children.`,
          })
        }
      }
    }
    if (typeof comp.child === 'string' && !compById.has(comp.child)) {
      messages.push({
        severity: 'error',
        componentId: cid,
        message: `"child" references id "${comp.child}" which does not exist in the component set. Add a component with id "${comp.child}" or remove it.`,
      })
    }

    // DataList templateId validation
    if (comp.component === 'DataList' && comp.children && typeof comp.children === 'object' && !Array.isArray(comp.children)) {
      const childrenObj = comp.children as Record<string, unknown>
      if (childrenObj.templateId) {
        const tid = String(childrenObj.templateId)
        if (!compById.has(tid)) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `DataList templateId "${tid}" does not exist in the component set. Add a component with id "${tid}" to use as the repeating template.`,
          })
        }
        if (!childrenObj.path) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `DataList has templateId but no "path" in children. Set children to { path: "/items", templateId: "${tid}" } to bind to data.`,
          })
        } else if (typeof childrenObj.path === 'string' && !childrenObj.path.startsWith('/')) {
          messages.push({
            severity: 'error',
            componentId: cid,
            message: `DataList children.path "${childrenObj.path}" must start with "/" (JSON Pointer to root data model, e.g. "/tasks"). Add a leading "/" to fix.`,
          })
        }
      }
    }
  }

  // Tabs ↔ children validation
  for (const comp of components) {
    if (comp.component !== 'Tabs' || !Array.isArray(comp.children)) continue
    const cid = String(comp.id)
    const childIds = comp.children as string[]
    const hasExplicitTabs = Array.isArray(comp.tabs) && (comp.tabs as unknown[]).length > 0

    if (!hasExplicitTabs) {
      const nonTabPanelChildren = childIds.filter((id) => {
        const child = compById.get(id)
        return child && child.component !== 'TabPanel'
      })
      if (nonTabPanelChildren.length > 0) {
        messages.push({
          severity: 'error',
          componentId: cid,
          message: `Tabs has no "tabs" prop and children [${nonTabPanelChildren.join(', ')}] are not TabPanel components. ` +
            `The tabs will render EMPTY. Fix: either (a) add an explicit "tabs" prop: ` +
            `tabs: [{ id: "tab1", label: "Label" }, ...], or (b) change children to TabPanel components with a "title" prop.`,
        })
      }

      const tabPanelsWithoutTitle = childIds.filter((id) => {
        const child = compById.get(id)
        return child && child.component === 'TabPanel' && !child.title
      })
      if (tabPanelsWithoutTitle.length > 0) {
        messages.push({
          severity: 'error',
          componentId: cid,
          message: `Tabs children [${tabPanelsWithoutTitle.join(', ')}] are TabPanel components missing the "title" prop. ` +
            `Without "title", tabs cannot auto-derive labels and will render EMPTY. ` +
            `Fix: add title="Label" to each TabPanel.`,
        })
      }
    }
  }

  return messages
}

const VALID_MUTATION_METHODS = new Set(['POST', 'PATCH', 'DELETE', 'OPEN'])

// ---------------------------------------------------------------------------
// Auto-correction: normalize known variant/enum mismatches
// ---------------------------------------------------------------------------

const ENUM_ALIASES: Record<string, Record<string, Record<string, string>>> = {
  Text: {
    variant: {
      xs: 'small',
      sm: 'small',
      md: 'body',
      lg: 'large',
      xl: 'h4',
      '2xl': 'h3',
      '3xl': 'h2',
      '4xl': 'h1',
      p: 'body',
      paragraph: 'body',
      title: 'h2',
      subtitle: 'h4',
      heading: 'h2',
      subheading: 'h4',
    },
  },
  Badge: {
    variant: {
      primary: 'default',
      info: 'secondary',
      error: 'destructive',
      danger: 'destructive',
      warning: 'outline',
      success: 'default',
    },
  },
  Button: {
    variant: {
      primary: 'default',
      danger: 'destructive',
      text: 'link',
      flat: 'ghost',
    },
    size: {
      xs: 'sm',
      xl: 'lg',
    },
  },
}

export interface NormalizationResult {
  components: Array<{ [k: string]: unknown }>
  corrections: string[]
}

/**
 * Auto-correct known invalid enum values in component props.
 * Returns the corrected components array and a list of human-readable corrections.
 */
export function normalizeComponents(
  components: Array<{ id?: string; component?: string;[k: string]: unknown }>
): NormalizationResult {
  const corrections: string[] = []

  const normalized = components.map((comp) => {
    const schema = comp.component ? getComponentSchema(comp.component) : null
    if (!schema) return comp

    const aliases = ENUM_ALIASES[schema.type]
    if (!aliases) return comp

    const patched = { ...comp }
    for (const [propName, aliasMap] of Object.entries(aliases)) {
      const val = patched[propName]
      if (typeof val === 'string' && aliasMap[val]) {
        const corrected = aliasMap[val]
        corrections.push(`${comp.id}: ${schema.type}.${propName} "${val}" → "${corrected}"`)
        patched[propName] = corrected
      }
    }

    // General fallback: for any enum prop with an invalid value, try closest match
    for (const [propName, propDef] of Object.entries(schema.props)) {
      const val = patched[propName]
      if (val !== undefined && propDef.enum && typeof val === 'string' && !propDef.enum.includes(val)) {
        const lower = val.toLowerCase()
        const match = propDef.enum.find((e: string) => e.toLowerCase() === lower)
        if (match) {
          corrections.push(`${comp.id}: ${schema.type}.${propName} "${val}" → "${match}" (case fix)`)
          patched[propName] = match
        }
      }
    }

    return patched
  })

  return { components: normalized, corrections }
}

// ---------------------------------------------------------------------------
// Basic agent schema (display + interactive: Checkbox, Select, Delete button)
// ---------------------------------------------------------------------------

const BASIC_ACTION_PROP: PropDef = {
  type: 'object',
  description: `Action for opening external URLs: { name: "open_link", mutation: { endpoint: "https://example.com" OR { path: "url" }, method: "OPEN" } }
  method "OPEN" opens the resolved endpoint in a new browser tab. Use this for per-item URLs in a DataList (e.g. Airbnb listing URLs).
  The ONLY supported method is "OPEN". Do NOT use POST, PATCH, or DELETE — those are handled automatically by Checkbox, Select, and deleteAction.`,
}

export const BASIC_CANVAS_COMPONENT_SCHEMA: ComponentSchema[] = [
  ...CANVAS_COMPONENT_SCHEMA.filter((s) =>
    s.category !== 'interactive'
  ),
  {
    type: 'Button',
    category: 'interactive',
    description: `Clickable button. Two modes:
  1. Open external URL: action: { name: "view", mutation: { endpoint: "https://..." OR { path: "url" }, method: "OPEN" } }
  2. Delete DataList item: set deleteAction: true (the system handles the DELETE automatically).
  In a DataList, bind per-item URLs with { path: "url" } in the endpoint.`,
    hasChildren: false,
    props: {
      label: str('Button text', { required: true }),
      text: str('Alias for label'),
      variant: str('Visual style', { enum: ['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'], default: 'default' }),
      size: str('Button size', { enum: ['default', 'sm', 'lg', 'icon'], default: 'default' }),
      disabled: bool('Disable the button'),
      action: BASIC_ACTION_PROP,
      deleteAction: bool('When true, clicking deletes the current DataList item from the API. No mutation config needed — the system auto-derives the DELETE.'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Checkbox',
    category: 'interactive',
    description: `Toggle a boolean field on an API model record. Place inside a DataList template bound to an API model.
  The system auto-PATCHes the API record when toggled — no mutation config needed.
  Example: { component: "Checkbox", checked: { path: "completed" }, dataPath: "completed" }`,
    hasChildren: false,
    props: {
      label: str('Checkbox label'),
      checked: bool('Bound boolean value — use { path: "fieldName" } for data binding'),
      dataPath: str('Field name to toggle (e.g. "completed"). Auto-included in the PATCH body.', { required: true }),
      disabled: bool('Disable the checkbox'),
      className: CLASS_PROP,
    },
  },
  {
    type: 'Select',
    category: 'interactive',
    description: `Dropdown to change a field value on an API model record. Place inside a DataList template bound to an API model.
  The system auto-PATCHes the API record when changed — no mutation config needed.
  Example: { component: "Select", value: { path: "priority" }, dataPath: "priority", options: [{ label: "Low", value: "low" }, { label: "High", value: "high" }] }`,
    hasChildren: false,
    props: {
      label: str('Field label'),
      options: arr('Options: [{ label, value }]', {
        label: str('Display text', { required: true }),
        value: str('Option value', { required: true }),
      }),
      value: str('Current value — use { path: "fieldName" } for data binding'),
      placeholder: str('Placeholder option text'),
      dataPath: str('Field name to update (e.g. "priority"). Auto-included in the PATCH body.', { required: true }),
      disabled: bool('Disable the select'),
      className: CLASS_PROP,
    },
  },
]

const basicSchemaByType = new Map<string, ComponentSchema>()
for (const s of BASIC_CANVAS_COMPONENT_SCHEMA) {
  basicSchemaByType.set(s.type, s)
}

export const BASIC_VALID_COMPONENT_TYPES = new Set(BASIC_CANVAS_COMPONENT_SCHEMA.map((s) => s.type))

export function getBasicComponentSchema(type: string): ComponentSchema | undefined {
  return basicSchemaByType.get(type)
}

// ---------------------------------------------------------------------------
// Fuzzy match helper (Levenshtein distance)
// ---------------------------------------------------------------------------

function findClosestType(input: string): string | null {
  const lower = input.toLowerCase()
  let best: string | null = null
  let bestDist = Infinity

  for (const t of VALID_COMPONENT_TYPES) {
    const d = levenshtein(lower, t.toLowerCase())
    if (d < bestDist && d <= 3) {
      bestDist = d
      best = t
    }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[m][n]
}
