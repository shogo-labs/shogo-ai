/**
 * TodoWidget Test Page
 * 
 * A simple test page to verify the TodoWidget component works correctly.
 * This page is accessible without authentication for local testing.
 */

import { useState } from "react"
import { TodoWidget } from "@/components/app/chat/turns/TodoWidget"
import type { ToolCallData } from "@/components/app/chat/tools/types"
import { Button } from "@/components/ui/button"

// Mock tool data generator
function createMockTodoTool(
  todos: Array<{ id: string; content: string; status: string }>,
  state: "streaming" | "success" | "error" = "success"
): ToolCallData {
  return {
    id: `todo-${Date.now()}`,
    toolName: "TodoWrite",
    category: "other",
    state,
    args: {
      todos,
      merge: false,
    },
    timestamp: Date.now(),
  }
}

// Preset scenarios
const SCENARIOS = {
  empty: {
    name: "Empty (no todos)",
    tool: createMockTodoTool([], "success"),
  },
  streaming: {
    name: "Streaming (loading)",
    tool: createMockTodoTool([], "streaming"),
  },
  allPending: {
    name: "All Pending",
    tool: createMockTodoTool([
      { id: "1", content: "Add Priority enum to schema", status: "pending" },
      { id: "2", content: "Run bun run generate", status: "pending" },
      { id: "3", content: "Update UI to show priority", status: "pending" },
    ]),
  },
  inProgress: {
    name: "In Progress",
    tool: createMockTodoTool([
      { id: "1", content: "Add Priority enum to schema", status: "completed" },
      { id: "2", content: "Run bun run generate", status: "in_progress" },
      { id: "3", content: "Update UI to show priority", status: "pending" },
    ]),
  },
  allComplete: {
    name: "All Complete",
    tool: createMockTodoTool([
      { id: "1", content: "Add Priority enum to schema", status: "completed" },
      { id: "2", content: "Run bun run generate", status: "completed" },
      { id: "3", content: "Update UI to show priority", status: "completed" },
    ]),
  },
  withCancelled: {
    name: "With Cancelled",
    tool: createMockTodoTool([
      { id: "1", content: "Add Priority enum to schema", status: "completed" },
      { id: "2", content: "Try approach A (didn't work)", status: "cancelled" },
      { id: "3", content: "Use approach B instead", status: "in_progress" },
      { id: "4", content: "Update UI to show priority", status: "pending" },
    ]),
  },
  complex: {
    name: "Complex (many tasks)",
    tool: createMockTodoTool([
      { id: "1", content: "Analyze user requirements", status: "completed" },
      { id: "2", content: "Design database schema", status: "completed" },
      { id: "3", content: "Create Prisma models", status: "completed" },
      { id: "4", content: "Generate types and server functions", status: "completed" },
      { id: "5", content: "Build list view component", status: "in_progress" },
      { id: "6", content: "Build form component", status: "pending" },
      { id: "7", content: "Add validation", status: "pending" },
      { id: "8", content: "Test CRUD operations", status: "pending" },
    ]),
  },
}

export function TodoWidgetTestPage() {
  const [selectedScenario, setSelectedScenario] = useState<keyof typeof SCENARIOS>("inProgress")
  const [isExpanded, setIsExpanded] = useState(true)

  const currentScenario = SCENARIOS[selectedScenario]

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">TodoWidget Test Page</h1>
          <p className="text-muted-foreground mt-2">
            Test the TodoWidget component with different scenarios.
          </p>
        </div>

        {/* Scenario selector */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Select Scenario:</label>
          <div className="flex flex-wrap gap-2">
            {Object.entries(SCENARIOS).map(([key, scenario]) => (
              <Button
                key={key}
                variant={selectedScenario === key ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedScenario(key as keyof typeof SCENARIOS)}
              >
                {scenario.name}
              </Button>
            ))}
          </div>
        </div>

        {/* Widget display */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">TodoWidget Preview:</label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? "Test Collapse" : "Test Expand"}
            </Button>
          </div>
          
          {/* Dark background to simulate chat panel */}
          <div className="bg-card border rounded-lg p-4">
            <TodoWidget
              tool={currentScenario.tool}
              isExpanded={isExpanded}
              onToggle={() => setIsExpanded(!isExpanded)}
            />
          </div>
        </div>

        {/* Debug info */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Tool Data (Debug):</label>
          <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-64">
            {JSON.stringify(currentScenario.tool, null, 2)}
          </pre>
        </div>

        {/* Instructions */}
        <div className="text-sm text-muted-foreground space-y-1">
          <p><strong>How this works in the real app:</strong></p>
          <ol className="list-decimal list-inside space-y-1 ml-2">
            <li>Agent receives a complex task (3+ steps)</li>
            <li>Agent calls TodoWrite tool to create task list</li>
            <li>AssistantContent detects TodoWrite and renders TodoWidget</li>
            <li>As agent progresses, it updates todos with merge: true</li>
            <li>UI updates reactively showing progress</li>
          </ol>
        </div>
      </div>
    </div>
  )
}

export default TodoWidgetTestPage
