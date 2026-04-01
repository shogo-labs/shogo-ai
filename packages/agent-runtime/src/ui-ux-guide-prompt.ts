// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UI/UX Design Best Practices — Canvas Code Mode
 *
 * Actionable design principles for building polished, professional interfaces
 * in canvas code mode (h() / React / Tailwind in canvas/*.ts).
 *
 * Override key: ui_ux_design_guide
 */

export const UI_UX_DESIGN_GUIDE = `## UI/UX Design Guide — Build Polished Interfaces

Every canvas UI should look like a finished product, not a prototype. Follow these principles for every interface you build.

### Visual Hierarchy

Control the viewer's eye with size, weight, and color contrast:
- **Page title**: \`text-2xl font-bold tracking-tight\`
- **Section title**: \`text-lg font-semibold\`
- **Card title**: Use \`CardTitle\` (already styled)
- **Body text**: \`text-sm\` (default)
- **Captions / metadata**: \`text-xs text-muted-foreground\`
- **Large numbers / KPIs**: \`text-3xl font-bold tabular-nums\`

Always pair headings with a subtitle or description for context. A title alone looks unfinished.

\`\`\`
// GOOD — title with context
h('div', { className: 'space-y-1' }, [
  h('h2', { key: 't', className: 'text-2xl font-bold tracking-tight' }, 'Sales Dashboard'),
  h('p', { key: 'd', className: 'text-sm text-muted-foreground' }, 'Revenue and performance for Q1 2026'),
])

// BAD — bare title with no context
h('h2', { className: 'text-2xl font-semibold' }, 'Dashboard')
\`\`\`

### Spacing and Rhythm

Consistent spacing is the single biggest factor in making a UI look professional:
- **Between major sections**: \`gap-6\` or \`gap-8\`
- **Between related items** (e.g. metrics in a row): \`gap-4\`
- **Between tightly coupled elements** (label + value): \`gap-1\` or \`gap-2\`
- **Container padding**: \`p-6\` for major sections, \`p-4\` minimum for cards
- **Page-level wrapper**: \`flex flex-col gap-6 p-2\` (canvas provides outer padding)

Never use \`gap-0\` or skip gaps between sections. When in doubt, add more space — cramped UIs always look worse than spacious ones.

### Color with Purpose

Use color to convey meaning, not decoration:
- **Positive / success**: \`text-emerald-600 dark:text-emerald-400\`
- **Negative / danger**: \`text-red-600 dark:text-red-400\`
- **Warning / caution**: \`text-amber-600 dark:text-amber-400\`
- **Neutral info**: \`text-muted-foreground\`
- **Primary action**: Use \`Button\` default variant (auto-themed)

For backgrounds, use subtle fills to group content:
- \`bg-muted/50\` — very subtle grouping
- \`bg-muted\` — visible grouping
- \`bg-card\` — card-level surface (usually handled by \`Card\`)

Always include dark mode variants when using raw color classes. Prefer semantic tokens (\`text-foreground\`, \`text-muted-foreground\`, \`bg-muted\`) which auto-adapt to dark mode.

### Card and Section Design

Cards are the primary visual grouping unit. Use them generously:
- Wrap every distinct data section in a \`Card\`
- Always include \`CardHeader\` with both \`CardTitle\` and \`CardDescription\`
- Use \`CardContent\` for the body — never put content directly in \`Card\`
- For dashboard grids, wrap each chart/table/list in its own card

\`\`\`
// GOOD — descriptive card
h(Card, { key: 'revenue' }, [
  h(CardHeader, { key: 'hdr' }, [
    h(CardTitle, { key: 't' }, 'Monthly Revenue'),
    h(CardDescription, { key: 'd' }, 'Total revenue across all channels'),
  ]),
  h(CardContent, { key: 'c' }, /* chart or content here */),
])

// BAD — card with no description, content not in CardContent
h(Card, { key: 'revenue' }, [
  h(CardHeader, { key: 'hdr' }, h(CardTitle, {}, 'Revenue')),
  h(Table, { key: 'table' }, /* ... */),
])
\`\`\`

### Data Display Polish

Numbers and data should be formatted and color-coded:
- **Format large numbers**: Use commas (\`1,500\` not \`1500\`) and abbreviations (\`$45.2K\`, \`1.2M\`)
- **Align numbers**: Use \`tabular-nums\` and \`text-right\` in table columns
- **Color-code trends**: Green for positive change, red for negative — never leave trends uncolored
- **Status values**: Always use \`Badge\` with a meaningful variant — never display raw status text

\`\`\`
// GOOD — polished metric with trend
h(Metric, { key: 'rev', label: 'Revenue', value: '$45.2K', trend: 'up', trendValue: '+12.3%' })

// GOOD — color-coded inline trend
h('div', { className: 'flex items-center gap-2' }, [
  h('span', { key: 'v', className: 'text-3xl font-bold tabular-nums' }, '$45,200'),
  h('span', { key: 't', className: 'text-sm font-medium text-emerald-600 dark:text-emerald-400' }, '+12.3%'),
])

// BAD — unstyled number, no trend color
h('span', { className: 'text-2xl' }, '45200')
\`\`\`

For tables:
- Style header cells: \`TableHead\` already applies muted styling — use it
- Add \`hover:bg-muted/50 transition-colors\` on \`TableRow\` for interactive feel
- Right-align numeric columns
- Use \`Badge\` for status/category columns
- Show formatted dates (\`Jan 15, 2026\` not \`2026-01-15T00:00:00Z\`)

### Empty States

Never show a blank space when data is absent. Always show an empty state:
\`\`\`
// GOOD — meaningful empty state
h('div', { className: 'flex flex-col items-center justify-center py-12 text-center' }, [
  h(Inbox, { key: 'icon', className: 'h-12 w-12 text-muted-foreground/50 mb-4' }),
  h('h3', { key: 't', className: 'text-lg font-semibold' }, 'No leads yet'),
  h('p', { key: 'd', className: 'text-sm text-muted-foreground max-w-sm' }, 'Leads will appear here once they are added to your pipeline.'),
])

// BAD — empty table or nothing at all
items.length === 0 ? null : h(Table, /* ... */)
\`\`\`

### Loading States

Skeleton placeholders should match the shape of the final content:
\`\`\`
// GOOD — skeletons that mirror the final layout
h('div', { className: 'flex flex-col gap-6 p-2' }, [
  h('div', { key: 'header', className: 'space-y-2' }, [
    h(Skeleton, { key: 1, className: 'h-8 w-48' }),
    h(Skeleton, { key: 2, className: 'h-4 w-72' }),
  ]),
  h(Row, { key: 'metrics', gap: 'md' }, [
    h(Skeleton, { key: 1, className: 'h-24 flex-1 rounded-lg' }),
    h(Skeleton, { key: 2, className: 'h-24 flex-1 rounded-lg' }),
    h(Skeleton, { key: 3, className: 'h-24 flex-1 rounded-lg' }),
  ]),
  h(Skeleton, { key: 'table', className: 'h-64 w-full rounded-lg' }),
])
\`\`\`

### Interactive Polish

Small details that elevate quality:
- Table rows: \`hover:bg-muted/50 transition-colors\`
- Clickable cards: \`hover:shadow-md transition-shadow cursor-pointer\`
- Buttons: Use correct variants — \`default\` for primary, \`outline\` for secondary, \`ghost\` for tertiary, \`destructive\` for dangerous actions
- Icon + text: Always pair action buttons with icons — \`h(Button, {}, [h(Plus, { key: 'i', className: 'h-4 w-4 mr-2' }), 'Add Lead'])\`

### Layout Composition — The Universal Dashboard Skeleton

For any dashboard or data display, use this structure:

\`\`\`
return h('div', { className: 'flex flex-col gap-6 p-2' }, [
  // 1. Header — title + context
  h('div', { key: 'header', className: 'flex items-center justify-between' }, [
    h('div', { key: 'left', className: 'space-y-1' }, [
      h('h2', { key: 't', className: 'text-2xl font-bold tracking-tight' }, 'Dashboard Title'),
      h('p', { key: 'd', className: 'text-sm text-muted-foreground' }, 'Subtitle with context'),
    ]),
    h(Badge, { key: 'badge', variant: 'outline' }, 'Q1 2026'),
  ]),

  // 2. Metrics row — 3 to 4 KPIs
  h(Row, { key: 'metrics', gap: 'md' }, [
    h(Metric, { key: 'm1', label: 'Total Revenue', value: '$45.2K', trend: 'up', trendValue: '+12%' }),
    h(Metric, { key: 'm2', label: 'Active Users', value: '1,284', trend: 'up', trendValue: '+8%' }),
    h(Metric, { key: 'm3', label: 'Churn Rate', value: '2.4%', trend: 'down', trendValue: '-0.3%' }),
  ]),

  // 3. Main content — charts, tables, or data grids
  h(Grid, { key: 'charts', columns: 2, gap: 'md' }, [
    h(Card, { key: 'chart1' }, [
      h(CardHeader, { key: 'hdr' }, [
        h(CardTitle, { key: 't' }, 'Revenue Over Time'),
        h(CardDescription, { key: 'd' }, 'Monthly revenue for the current quarter'),
      ]),
      h(CardContent, { key: 'c' }, /* chart */),
    ]),
    h(Card, { key: 'chart2' }, [
      h(CardHeader, { key: 'hdr' }, [
        h(CardTitle, { key: 't' }, 'Revenue by Category'),
        h(CardDescription, { key: 'd' }, 'Breakdown across product lines'),
      ]),
      h(CardContent, { key: 'c' }, /* chart */),
    ]),
  ]),

  // 4. Detail section — table or list
  h(Card, { key: 'details' }, [
    h(CardHeader, { key: 'hdr' }, [
      h(CardTitle, { key: 't' }, 'Recent Transactions'),
      h(CardDescription, { key: 'd' }, 'Last 30 days of activity'),
    ]),
    h(CardContent, { key: 'c' }, /* table */),
  ]),
])
\`\`\`

### Anti-Patterns — NEVER Do These

- **Bare text without structure**: Every piece of text needs proper sizing, weight, and color
- **Tables without row hover**: Always add \`hover:bg-muted/50 transition-colors\` to TableRow
- **Raw status strings**: Always wrap status/category in \`Badge\` with an appropriate variant
- **Missing empty states**: Show icon + title + description when no data is available
- **Cramped layouts**: Use \`gap-6\` between sections, \`p-6\` on card content
- **Unformatted numbers**: Always use commas, currency symbols, and abbreviations
- **Colorless trends**: Positive = green, negative = red — always color-code change values
- **No loading state**: Show Skeleton placeholders that match the final layout shape
- **Giant unstyled forms**: Group form fields in Cards, use Label + Input pairs with proper spacing
- **Icon-less action buttons**: Pair every primary action button with a lucide icon
- **Adding borders**: NEVER use \`border\`, \`border-t\`, \`border-b\`, \`divide-y\`, or any border utility on elements unless the user explicitly asks for borders. Cards and shadcn components handle their own borders — do not add extra ones. Use spacing and background color (\`bg-muted/50\`) for visual separation instead.
`
