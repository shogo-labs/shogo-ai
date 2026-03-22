// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useMemo } from 'react'

export interface CanvasTemplate {
  id: string
  user_request: string
  needs_api_schema: boolean
  component_types: string[]
  component_count: number
}

const CANVAS_TEMPLATES: CanvasTemplate[] = [
  {
    id: "analytics-dashboard",
    user_request: "Create a sales analytics dashboard with revenue chart and top products",
    needs_api_schema: false,
    component_types: ["Column", "Row", "Text", "Badge", "Grid", "Metric", "Card", "Chart", "Table"],
    component_count: 12,
  },
  {
    id: "task-tracker-crud",
    user_request: "Build a task tracker where I can add, complete, and delete tasks",
    needs_api_schema: true,
    component_types: ["Column", "Card", "Table", "Button", "TextField"],
    component_count: 8,
  },
  {
    id: "email-dashboard",
    user_request: "Build an email dashboard with metrics, tabs, and email tables",
    needs_api_schema: false,
    component_types: ["Column", "Grid", "Metric", "Separator", "Tabs", "Table", "Alert", "Text"],
    component_count: 14,
  },
  {
    id: "crm-pipeline",
    user_request: "Build a CRM pipeline canvas showing leads in 3 stages: New, Qualified, Closed with lead details",
    needs_api_schema: false,
    component_types: ["Column", "Grid", "Card", "Text", "Badge", "Metric"],
    component_count: 12,
  },
  {
    id: "support-tickets-crud",
    user_request: "Build a support ticket management app with CRUD API, priority levels, and status tracking",
    needs_api_schema: true,
    component_types: ["Column", "Table", "Button", "Badge"],
    component_count: 8,
  },
  {
    id: "expense-dashboard",
    user_request: "Create an expense tracker dashboard with total spend, budget remaining, and a table of recent expenses",
    needs_api_schema: false,
    component_types: ["Column", "Row", "Metric", "Table", "Badge"],
    component_count: 8,
  },
  {
    id: "stock-dashboard-crud",
    user_request: "Create a stock portfolio dashboard with price tracking",
    needs_api_schema: true,
    component_types: ["Column", "Grid", "Metric", "Card", "Table", "Chart"],
    component_count: 10,
  },
  {
    id: "ecommerce-orders-crud",
    user_request: "Build an order management dashboard with CRUD showing order metrics, order table with status, and seed data",
    needs_api_schema: true,
    component_types: ["Column", "Row", "Metric", "Table", "Badge", "Button"],
    component_count: 12,
  },
  {
    id: "meeting-scheduler",
    user_request: "Create a meeting scheduler with date/time pickers and a submit button",
    needs_api_schema: false,
    component_types: ["Card", "Column", "TextField", "Select", "ChoicePicker", "Row", "Button"],
    component_count: 9,
  },
  {
    id: "notification-feed",
    user_request: "Show a notification feed with PR reviews, build failures, and meeting reminders",
    needs_api_schema: false,
    component_types: ["Column", "Text", "DataList", "Card", "Row", "Badge"],
    component_count: 7,
  },
  {
    id: "cicd-monitor",
    user_request: "Build a CI/CD pipeline monitor showing recent deploys with status and a deploy frequency chart",
    needs_api_schema: false,
    component_types: ["Column", "Card", "Table", "Badge", "Text", "Chart"],
    component_count: 10,
  },
  {
    id: "social-media-dashboard",
    user_request: "Build a social media analytics dashboard with follower/engagement metrics, trends chart, and scheduled posts table",
    needs_api_schema: false,
    component_types: ["Column", "Row", "Grid", "Metric", "Chart", "Table", "Badge"],
    component_count: 14,
  },
  {
    id: "invoice-tracker-crud",
    user_request: "Build an invoice tracker with CRUD API, client name, amount, due date, status, and total metric",
    needs_api_schema: true,
    component_types: ["Column", "Metric", "Table", "Badge", "Button"],
    component_count: 9,
  },
  {
    id: "hr-pipeline-crud",
    user_request: "Create a recruiting pipeline app tracking applicants with name, position, stage, rating, and notes",
    needs_api_schema: true,
    component_types: ["Column", "Table", "Badge", "Text", "Button"],
    component_count: 8,
  },
  {
    id: "research-report",
    user_request: "Build a research report on the EV market with progress tracking and expandable sections",
    needs_api_schema: false,
    component_types: ["Column", "Row", "Text", "Badge", "Card", "Chart", "Accordion", "AccordionItem", "Grid", "Metric", "Table", "Alert"],
    component_count: 17,
  },
  {
    id: "weather-display",
    user_request: "Show me the current weather forecast",
    needs_api_schema: false,
    component_types: ["Column", "Text", "Badge"],
    component_count: 4,
  },
  {
    id: "flight-search",
    user_request: "Find flights from SFO to JFK and let me pick one",
    needs_api_schema: false,
    component_types: ["Column", "Text", "Card", "Button"],
    component_count: 6,
  },
]

export function useTemplates() {
  const templates = useMemo(() => CANVAS_TEMPLATES, [])
  return { templates, isLoading: false }
}
