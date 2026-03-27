// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

export const CANVAS_V2_PROMPT = `## Canvas — Live React Display

Write React code to \`canvas/*.js\` and it renders instantly in the canvas panel.
Each file = a tab. Use \`write_file\` to create, \`edit_file\` to update, \`delete_file\` to remove.

Your code is executed via \`new Function()\` — write the **body** of a function that returns a React element. Do NOT use \`export\`, \`import\`, or JSX. Use \`h()\` (alias for \`React.createElement\`).

### Available Globals

**React**: \`h\` (createElement), \`Fragment\`, \`useState\`, \`useEffect\`, \`useMemo\`, \`useCallback\`, \`useRef\`, \`useReducer\`

**shadcn/ui**: \`Card\`, \`CardHeader\`, \`CardTitle\`, \`CardDescription\`, \`CardContent\`, \`CardFooter\`, \`Button\`, \`Badge\`, \`Input\`, \`Label\`, \`Textarea\`, \`Checkbox\`, \`Switch\`, \`Select\`, \`SelectTrigger\`, \`SelectValue\`, \`SelectContent\`, \`SelectItem\`, \`Tabs\`, \`TabsList\`, \`TabsTrigger\`, \`TabsContent\`, \`Table\`, \`TableHeader\`, \`TableBody\`, \`TableRow\`, \`TableHead\`, \`TableCell\`, \`Dialog\`, \`DialogTrigger\`, \`DialogContent\`, \`DialogHeader\`, \`DialogTitle\`, \`DialogDescription\`, \`DialogFooter\`, \`Alert\`, \`AlertTitle\`, \`AlertDescription\`, \`Accordion\`, \`AccordionItem\`, \`AccordionTrigger\`, \`AccordionContent\`, \`Progress\`, \`Separator\`, \`ScrollArea\`, \`Skeleton\`, \`Avatar\`, \`AvatarImage\`, \`AvatarFallback\`, \`DropdownMenu\`, \`DropdownMenuTrigger\`, \`DropdownMenuContent\`, \`DropdownMenuItem\`, \`Sheet\`, \`SheetTrigger\`, \`SheetContent\`, \`SheetHeader\`, \`SheetTitle\`, \`Popover\`, \`PopoverTrigger\`, \`PopoverContent\`, \`Tooltip\`, \`TooltipProvider\`, \`TooltipTrigger\`, \`TooltipContent\`

**Canvas components**: \`Column\`, \`Row\`, \`Grid\`, \`CanvasCard\`, \`CanvasScrollArea\`, \`Metric\`, \`DataList\`, \`DynText\`, \`DynBadge\`, \`DynImage\`, \`DynTable\`, \`DynChart\`

**Recharts**: \`ResponsiveContainer\`, \`LineChart\`, \`BarChart\`, \`AreaChart\`, \`PieChart\`, \`Line\`, \`Bar\`, \`Area\`, \`Pie\`, \`Cell\`, \`XAxis\`, \`YAxis\`, \`CartesianGrid\`, \`RechartsTooltip\`, \`Legend\`

**Icons**: All lucide-react icons (\`TrendingUp\`, \`Search\`, \`Calendar\`, \`ArrowRight\`, etc.)

**Utilities**: \`cn\` (classname merge), \`fetch\`, \`data\` (parsed from canvas/<name>.data.json), \`onAction(name, context)\`

### Data

Write JSON to \`canvas/<name>.data.json\` — available as \`data\` in your code.
Or use \`fetch()\` inside \`useEffect\` to load data from any API.

### Style

Use Tailwind CSS classes. The canvas supports both light and dark mode automatically.

### Example

\`\`\`
write_file({ path: "canvas/dashboard.js", content: \`
  var tasks = (data && data.tasks) || []
  var done = tasks.filter(function(t) { return t.status === 'done' }).length

  return h('div', { className: 'flex flex-col gap-6 p-2' }, [
    h('h2', { className: 'text-2xl font-semibold' }, 'Dashboard'),
    h(Row, { gap: 'md' }, [
      h(Metric, { key: 'total', label: 'Total', value: tasks.length }),
      h(Metric, { key: 'done', label: 'Done', value: done, trend: 'up', trendValue: '+' + done }),
    ]),
    h(Card, {}, [
      h(CardHeader, {}, h(CardTitle, {}, 'Tasks')),
      h(CardContent, {},
        h(Table, {}, [
          h(TableHeader, {},
            h(TableRow, {}, [
              h(TableHead, { key: 'task' }, 'Task'),
              h(TableHead, { key: 'status' }, 'Status'),
            ])
          ),
          h(TableBody, {},
            tasks.map(function(t, i) {
              return h(TableRow, { key: i }, [
                h(TableCell, { key: 'title' }, t.title),
                h(TableCell, { key: 'status' }, h(Badge, {}, t.status)),
              ])
            })
          ),
        ])
      ),
    ]),
  ])
\`})
\`\`\`

### Hooks work — state, effects, fetch

\`\`\`
var _state = useState(0)
var count = _state[0], setCount = _state[1]
return h(Button, { onClick: function() { setCount(function(c) { return c + 1 }) } }, 'Clicks: ' + count)
\`\`\`

### Network requests

\`\`\`
var _state = useState([])
var items = _state[0], setItems = _state[1]
useEffect(function() {
  fetch('https://api.example.com/items').then(function(r) { return r.json() }).then(setItems)
}, [])
\`\`\`

### Important rules
- Do NOT use \`export\`, \`import\`, \`const\`, \`let\`, or arrow functions — use \`var\` and \`function\` expressions for full compatibility with \`new Function()\`.
- Use \`h()\` instead of JSX.
- Return a single React element from the top level.
- Each \`canvas/*.js\` file is a separate tab.
- Keys are required on list items.
`
