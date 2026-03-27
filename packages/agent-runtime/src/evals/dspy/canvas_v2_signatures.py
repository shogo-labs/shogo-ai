"""Canvas V2 (code mode) DSPy signatures.

These signatures define the input/output schema for DSPy optimization
of the 4 canvas v2 prompt sections. Each signature maps to an override
key in gateway.ts:

  canvas_v2_guide          → CanvasV2Planning
  canvas_v2_backend_guide  → CanvasV2BackendPlanning
  canvas_v2_react_guide    → CanvasV2ReactPatterns
  canvas_v2_examples       → CanvasV2E2E
"""

import dspy


class CanvasV2Planning(dspy.Signature):
    """Plan a canvas v2 app from a user request.

    Decide whether the app needs a skill server backend, choose canvas
    filenames, determine the tool sequence, and list React patterns needed.
    """
    user_request: str = dspy.InputField(desc="User's request for a canvas UI")
    available_components: str = dspy.InputField(
        desc="Available components: Card, Button, Badge, Input, Table, Metric, "
             "Chart (via Recharts), Tabs, Switch, Checkbox, Accordion, Dialog, "
             "Row, Column, Grid, DynTable, DynChart, DataList, Progress, Skeleton"
    )

    needs_backend: bool = dspy.OutputField(desc="True if app needs skill server (persistent CRUD data)")
    prisma_models: str = dspy.OutputField(desc="Comma-separated Prisma model names, or 'none'")
    canvas_files: str = dspy.OutputField(desc="Comma-separated canvas/*.js filenames")
    tool_sequence: str = dspy.OutputField(
        desc="Ordered tool calls, e.g. 'write_file (schema.prisma), write_file (canvas/app.js)'"
    )
    react_patterns: str = dspy.OutputField(
        desc="React patterns used: useState, useEffect, fetch, loading state, form, optimistic update"
    )
    reasoning: str = dspy.OutputField(desc="Why this plan is optimal")


class CanvasV2BackendPlanning(dspy.Signature):
    """Design the skill server backend for a canvas v2 app.

    Given a user request, produce the Prisma schema and describe
    how the canvas code should fetch from the REST API.
    """
    user_request: str = dspy.InputField(desc="User's request describing what data the app manages")
    existing_schema: str = dspy.InputField(
        desc="Current schema.prisma content (empty string for new apps)"
    )

    prisma_schema: str = dspy.OutputField(
        desc="Complete schema.prisma content with datasource, generator, and models"
    )
    api_endpoints: str = dspy.OutputField(
        desc="Comma-separated REST endpoints, e.g. 'GET /api/leads, POST /api/leads, PATCH /api/leads/:id'"
    )
    fetch_patterns: str = dspy.OutputField(
        desc="How canvas code should fetch: useEffect load, POST for create, PATCH for update, DELETE"
    )
    reasoning: str = dspy.OutputField()


class CanvasV2ReactPatterns(dspy.Signature):
    """Choose the right React patterns for a canvas v2 component.

    Given the app requirements, determine what React hooks, state
    management, and UI patterns to use.
    """
    user_request: str = dspy.InputField(desc="User's request")
    has_backend: bool = dspy.InputField(desc="Whether the app has a skill server backend")

    state_variables: str = dspy.OutputField(
        desc="useState variables needed, e.g. 'items (array), loading (bool), name (string)'"
    )
    effects: str = dspy.OutputField(
        desc="useEffect hooks needed, e.g. 'load items on mount, refetch on filter change'"
    )
    ui_sections: str = dspy.OutputField(
        desc="UI sections: 'header with metrics, form card, data table, chart'"
    )
    quality_patterns: str = dspy.OutputField(
        desc="Quality patterns applied: 'loading skeleton, error alert, optimistic delete, key props'"
    )
    reasoning: str = dspy.OutputField()


class CanvasV2E2E(dspy.Signature):
    """Generate a COMPLETE canvas v2 app spec from a user request.

    Produces everything needed to build and verify the app:
    1. Whether a backend is needed
    2. The Prisma schema (if backend)
    3. The canvas/*.js file content
    4. Optional canvas/*.data.json content
    """
    user_request: str = dspy.InputField(desc="User's request for a canvas UI")
    available_components: str = dspy.InputField(
        desc="Available components: Card, Button, Badge, Input, Table, Metric, "
             "Row, Column, Grid, Tabs, Switch, Checkbox, Skeleton, Alert"
    )

    needs_backend: bool = dspy.OutputField(desc="True if app needs skill server")
    prisma_schema: str = dspy.OutputField(
        desc="Complete schema.prisma content, or empty string if no backend"
    )
    canvas_filename: str = dspy.OutputField(desc="Primary canvas filename, e.g. 'canvas/leads.js'")
    canvas_code: str = dspy.OutputField(
        desc="Complete canvas/*.js file content using h(), var, function patterns"
    )
    data_json: str = dspy.OutputField(
        desc="canvas/*.data.json content if needed, or empty string"
    )
    tool_sequence: str = dspy.OutputField(desc="Ordered tool calls used to build the app")
    reasoning: str = dspy.OutputField(desc="Design rationale")
