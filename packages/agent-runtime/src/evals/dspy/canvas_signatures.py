"""Canvas track DSPy signatures."""

import dspy


class CanvasPlanning(dspy.Signature):
    """Given a user request for a visual UI, plan the canvas creation strategy.

    Decide whether the app needs an API schema (CRUD app) or is data-only,
    choose a surface ID, determine the optimal tool sequence, and list
    the component types needed.
    """
    user_request: str = dspy.InputField(desc="User's request for a canvas UI")
    available_components: str = dspy.InputField(
        desc="JSON list of available component types: Column, Row, Grid, Card, Text, Badge, "
             "Metric, Button, Table, Chart, Tabs, Accordion, Alert, Separator, TextField, "
             "Select, ChoicePicker, DataList, Image"
    )

    needs_api_schema: bool = dspy.OutputField(desc="True if the app needs CRUD/persistent data via canvas_api_schema")
    surface_id: str = dspy.OutputField(desc="Kebab-case surface identifier, e.g. 'task-tracker'")
    tool_sequence: str = dspy.OutputField(
        desc="Ordered comma-separated list of canvas tool calls, e.g. "
             "'canvas_create, canvas_api_schema, canvas_api_seed, canvas_api_query, canvas_update'"
    )
    component_types: str = dspy.OutputField(desc="Comma-separated component types needed, e.g. 'Column, Card, Table, Button'")
    reasoning: str = dspy.OutputField(desc="Why this plan is optimal")


class ComponentTreeGeneration(dspy.Signature):
    """Generate a valid component tree JSON for a canvas surface.

    The tree must follow these rules:
    - Root must be a layout component (Column, Row, Grid, Card)
    - All children refs must resolve to components in the array
    - Data bindings use JSON Pointer format: { path: "/field" } for root data,
      { path: "field" } for DataList item context
    - Buttons with actions use: { name: "action_name", context: { ... } }
    - Mutation buttons use: { name: "x", context: { _mutation: { endpoint, method, body } } }
    """
    plan: str = dspy.InputField(desc="Canvas plan from CanvasPlanning")
    data_shape: str = dspy.InputField(desc="JSON shape of the data model that will be bound")

    component_tree: str = dspy.OutputField(desc="JSON array of ComponentDefinition objects")
    data_binding_paths: str = dspy.OutputField(desc="Comma-separated JSON Pointer paths used in bindings")
    reasoning: str = dspy.OutputField()


class ApiSchemaDesign(dspy.Signature):
    """Design a managed API schema for a CRUD canvas app.

    Each model has PascalCase name and typed fields.
    Valid field types: String, Int, Float, Boolean, DateTime, Json.
    Every model gets auto-generated id (UUID) and createdAt fields.
    """
    user_request: str = dspy.InputField(desc="What the CRUD app should manage")
    existing_models: str = dspy.InputField(desc="JSON array of already-defined models (empty for new apps)")

    models: str = dspy.OutputField(
        desc="JSON array of ModelDefinition: [{name, fields: [{name, type, default?, optional?, unique?}]}]"
    )
    seed_data: str = dspy.OutputField(desc="JSON object mapping model name to array of seed records")
    reasoning: str = dspy.OutputField()


class CanvasE2E(dspy.Signature):
    """Generate a COMPLETE, executable canvas spec from a user request.

    This signature produces everything needed to actually build and verify
    the UI — not just a plan, but the real artifacts:

    1. surface_id: kebab-case identifier
    2. component_tree_json: VALID JSON array of ComponentDefinition objects
       - Root must be Column, Row, Grid, or Card
       - Children refs (string IDs) must resolve to other components
       - Data bindings use { "path": "/field/name" } (JSON Pointer)
    3. data_payload_json: VALID JSON object for the data model
       - All data binding paths in components must resolve to values here
    4. needs_api_schema: whether the app needs CRUD backend
    5. api_models_json: (if CRUD) JSON array of ModelDefinition
    6. api_seed_json: (if CRUD) JSON object mapping model -> seed records

    The output is executed against the real DynamicAppManager to verify it works.
    """
    user_request: str = dspy.InputField(desc="User's request for a canvas UI")
    available_components: str = dspy.InputField(
        desc="Available component types: Column, Row, Grid, Card, Text, Badge, "
             "Metric, Button, Table, Chart, Tabs, Accordion, AccordionItem, "
             "Alert, Separator, TextField, Select, ChoicePicker, DataList, Image, "
             "ScrollArea, TabPanel, Icon, Progress, Skeleton, Checkbox"
    )

    surface_id: str = dspy.OutputField(desc="Kebab-case surface identifier")
    needs_api_schema: bool = dspy.OutputField(desc="True if app needs CRUD via canvas_api_schema")
    component_tree_json: str = dspy.OutputField(
        desc='VALID JSON array of components. Example: '
             '[{"id":"root","component":"Column","children":["title","metric"]},'
             '{"id":"title","component":"Text","text":"Dashboard","variant":"h2"},'
             '{"id":"metric","component":"Metric","label":"Users","value":{"path":"/users"}}]'
    )
    data_payload_json: str = dspy.OutputField(
        desc='VALID JSON object for data model. All binding paths in components must resolve here. '
             'Example: {"users": 1500, "status": "active"}'
    )
    api_models_json: str = dspy.OutputField(
        desc='JSON array of ModelDefinition (empty [] if no API needed). '
             'Example: [{"name":"Todo","fields":[{"name":"title","type":"String"},{"name":"done","type":"Boolean"}]}]'
    )
    api_seed_json: str = dspy.OutputField(
        desc='JSON object mapping model name to seed records (empty {} if no API). '
             'Example: {"Todo":[{"title":"Buy milk","done":false}]}'
    )
    reasoning: str = dspy.OutputField(desc="Design rationale")
