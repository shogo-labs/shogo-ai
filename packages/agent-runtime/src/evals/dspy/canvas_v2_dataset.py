"""Canvas V2 seed dataset for DSPy bootstrap optimization.

Each example maps a user request to expected outputs for the
CanvasV2Planning and CanvasV2E2E signatures. These become the
training set for few-shot demo selection.

Usage:
  from canvas_v2_dataset import CANVAS_V2_DATASET
  trainset = [dspy.Example(**ex).with_inputs("user_request", "available_components")
              for ex in CANVAS_V2_DATASET]
"""

AVAILABLE_COMPONENTS = (
    "Card, Button, Badge, Input, Table, Metric, Row, Column, Grid, "
    "Tabs, Switch, Checkbox, Skeleton, Alert, Dialog, Accordion, "
    "DynTable, DynChart, DataList, Progress, DropdownMenu, Sheet"
)

CANVAS_V2_DATASET = [
    # 1. Simple display-only
    {
        "user_request": "Show me key metrics: 1500 users, $45K revenue, 342 sessions",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": False,
        "prisma_models": "none",
        "canvas_files": "canvas/dashboard.ts",
        "tool_sequence": "write_file (canvas/dashboard.ts)",
        "react_patterns": "useState",
        "reasoning": "Static metrics with no persistence — just render Metric components with hardcoded values.",
    },
    # 2. Interactive counter (no backend)
    {
        "user_request": "Build me a counter with increment and decrement",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": False,
        "prisma_models": "none",
        "canvas_files": "canvas/counter.ts",
        "tool_sequence": "write_file (canvas/counter.ts)",
        "react_patterns": "useState",
        "reasoning": "Client-side state only — useState for counter value, Button onClick handlers.",
    },
    # 3. Full-stack lead tracker
    {
        "user_request": "Build me a lead tracker to add and view leads with name, email, and status",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": True,
        "prisma_models": "Lead",
        "canvas_files": "canvas/leads.ts",
        "tool_sequence": "write_file (prisma/schema.prisma), write_file (canvas/leads.ts)",
        "react_patterns": "useState, useEffect, fetch, loading state, form",
        "reasoning": "CRUD operations need persistence — create Lead model, canvas fetches from /api/leads.",
    },
    # 4. Bookmark manager with search
    {
        "user_request": "I want a bookmark manager where I can save URLs with tags and search them",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": True,
        "prisma_models": "Bookmark",
        "canvas_files": "canvas/bookmarks.ts",
        "tool_sequence": "write_file (prisma/schema.prisma), write_file (canvas/bookmarks.ts)",
        "react_patterns": "useState, useEffect, fetch, loading state, form, filter",
        "reasoning": "Saving bookmarks requires persistence. Search = client-side filter on fetched data.",
    },
    # 5. Expense dashboard with chart
    {
        "user_request": "Build an expense tracker with category breakdown and spending chart",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": True,
        "prisma_models": "Expense",
        "canvas_files": "canvas/expenses.ts",
        "tool_sequence": "write_file (prisma/schema.prisma), write_file (canvas/expenses.ts)",
        "react_patterns": "useState, useEffect, fetch, loading state, form, chart (Recharts)",
        "reasoning": "Expenses need persistence. Chart via Recharts BarChart or PieChart for categories.",
    },
    # 6. Kanban board
    {
        "user_request": "Build a kanban board with Todo, In Progress, Done columns. Add and move tasks.",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": True,
        "prisma_models": "Task",
        "canvas_files": "canvas/board.ts",
        "tool_sequence": "write_file (prisma/schema.prisma), write_file (canvas/board.ts)",
        "react_patterns": "useState, useEffect, fetch, loading state, form, optimistic update",
        "reasoning": "Tasks with status changes need backend. PATCH to move between columns.",
    },
    # 7. CRM pipeline
    {
        "user_request": "Build a CRM with pipeline stages, deal values, and summary chart",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": True,
        "prisma_models": "Deal",
        "canvas_files": "canvas/crm.ts",
        "tool_sequence": "write_file (prisma/schema.prisma), write_file (canvas/crm.ts)",
        "react_patterns": "useState, useEffect, fetch, loading state, chart (Recharts), Metric",
        "reasoning": "Deals with pipeline stages and values. Summary metrics + bar chart by stage.",
    },
    # 8. Multi-surface (dashboard + settings)
    {
        "user_request": "Build a dashboard tab showing metrics and a settings tab with toggles",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": False,
        "prisma_models": "none",
        "canvas_files": "canvas/dashboard.ts, canvas/settings.ts",
        "tool_sequence": "write_file (canvas/dashboard.ts), write_file (canvas/settings.ts)",
        "react_patterns": "useState, Switch",
        "reasoning": "Two separate tabs, no persistence needed. Each is a separate canvas/*.ts file.",
    },
    # 9. Edit existing canvas — add chart
    {
        "user_request": "Add a line chart to the existing dashboard",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": False,
        "prisma_models": "none",
        "canvas_files": "canvas/dashboard.ts",
        "tool_sequence": "edit_file (canvas/dashboard.ts)",
        "react_patterns": "chart (Recharts)",
        "reasoning": "Existing file — use edit_file to add chart below existing metrics.",
    },
    # 10. Team roster display
    {
        "user_request": "Show our team: 5 engineers, 2 designers, 1 PM with names and roles",
        "available_components": AVAILABLE_COMPONENTS,
        "needs_backend": False,
        "prisma_models": "none",
        "canvas_files": "canvas/team.ts",
        "tool_sequence": "write_file (canvas/team.ts)",
        "react_patterns": "useState",
        "reasoning": "Static team data — render in a Table or Card grid. No backend needed.",
    },
]
