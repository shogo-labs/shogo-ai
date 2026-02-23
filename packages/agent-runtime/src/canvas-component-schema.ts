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
      value: str('Metric value (string or number), or use { path: "/revenue" } to bind to data model populated via canvas_api_query with dataPath'),
      unit: str('Unit suffix (e.g. "USD", "%")'),
      trend: str('Trend direction', { enum: ['up', 'down', 'neutral'] }),
      trendValue: str('Trend amount (e.g. "+12%")'),
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
    description: 'Simple chart (bar, horizontal bar, or progress). No external library needed.',
    hasChildren: false,
    props: {
      type: str('Chart type', { enum: ['bar', 'horizontalBar', 'progress'], default: 'bar' }),
      data: arr('Data points array, or use { path: "/metrics" } to bind to data model. Populate via canvas_api_query with dataPath.', {
        label: str('Point label', { required: true }),
        value: num('Point value', { required: true }),
        color: str('CSS color override'),
      }),
      title: str('Chart title'),
      height: num('Chart height in px (default 200)'),
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
    "action": { "name": "delete", "mutation": { "endpoint": "/api/tasks/:id", "method": "DELETE", "params": { "id": { "path": "id" } } } } }`,
    hasChildren: true,
    props: { emptyText: str('Text to show when empty'), className: CLASS_PROP },
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

    // Children: if schema says hasChildren but neither children nor child is provided, warn
    if (schema.hasChildren && !comp.children && !comp.child) {
      messages.push({
        severity: 'warning',
        componentId: cid,
        message: `"${schema.type}" supports children but neither "children" (array of IDs) nor "child" (single ID) was provided. The component will render empty.`,
      })
    }

    // Required props
    for (const [propName, propDef] of Object.entries(schema.props)) {
      if (propDef.required && comp[propName] === undefined) {
        messages.push({
          severity: 'warning',
          componentId: cid,
          message: `"${schema.type}" is missing recommended prop "${propName}" (${propDef.description}).`,
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

    // Unknown props — error: the prop is silently ignored, so the intended behavior won't work
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
      severity: 'warning',
      componentId: '(tree)',
      message: 'No component with id "root" found. The component tree needs a "root" node to render.',
    })
  }

  // Cross-component: Tabs ↔ children validation
  const compById = new Map(components.filter((c) => c.id).map((c) => [c.id, c]))
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
