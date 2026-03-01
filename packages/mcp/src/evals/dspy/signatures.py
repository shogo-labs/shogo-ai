"""
DSPy Signatures for Shogo Agent

Signatures define the input/output contract for the agent behavior we want to optimize.
"""

import dspy


class TemplateSelection(dspy.Signature):
    """Select the most appropriate starter template for a user's app request.
    
    Given a user request, determine which template best matches their needs.
    If the request is ambiguous, you may ask ONE clarifying question.
    If no template matches, explain the limitation and offer alternatives.
    
    Available templates:
    - todo-app: Task lists, checklists, daily todos
    - expense-tracker: Budget tracking, spending, personal finance
    - crm: Customer management, sales pipeline, leads, contacts
    - inventory: Stock management, products, warehouse, suppliers
    - kanban: Project boards, cards, drag-and-drop, agile
    - ai-chat: Chatbots, AI assistants, conversational interfaces
    - form-builder: Dynamic forms, surveys, questionnaires
    - feedback-form: User feedback, reviews, ratings
    - booking-app: Appointments, scheduling, reservations
    """
    
    user_request: str = dspy.InputField(desc="The user's request for building an application")
    
    selected_template: str = dspy.OutputField(
        desc="The template name to use (e.g., 'todo-app') or 'clarify' if ambiguous or 'none' if no match"
    )
    reasoning: str = dspy.OutputField(
        desc="Brief explanation of why this template was selected"
    )
    clarifying_question: str = dspy.OutputField(
        desc="If 'clarify' was selected, the ONE question to ask. Empty otherwise."
    )


class ToolCallGeneration(dspy.Signature):
    """Generate the correct tool call for setting up a project from a template.
    
    Given a user request and selected template, generate the appropriate
    template.copy tool call with correct parameters.
    """
    
    user_request: str = dspy.InputField(desc="The user's original request")
    selected_template: str = dspy.InputField(desc="The template to use")
    
    tool_name: str = dspy.OutputField(desc="Should be 'template.copy'")
    template_param: str = dspy.OutputField(desc="The template name parameter")
    name_param: str = dspy.OutputField(desc="The project name (derived from request or reasonable default)")
    theme_param: str = dspy.OutputField(desc="Theme if specified ('default', 'lavender', 'glacier') or empty")


class ResponseGeneration(dspy.Signature):
    """Generate a helpful response after template setup.
    
    After setting up a template, generate a response that:
    1. Confirms what was created
    2. Highlights key features
    3. Offers customization options
    """
    
    user_request: str = dspy.InputField(desc="The user's original request")
    template: str = dspy.InputField(desc="The template that was used")
    setup_success: bool = dspy.InputField(desc="Whether setup completed successfully")
    
    response: str = dspy.OutputField(
        desc="Helpful response confirming setup and offering next steps"
    )


# Combined module for full agent behavior
class ShogoTemplateAgent(dspy.Module):
    """Complete Shogo agent for template-based app creation.
    
    This module combines template selection, tool call generation,
    and response generation into a single optimizable pipeline.
    """
    
    def __init__(self):
        super().__init__()
        self.select_template = dspy.ChainOfThought(TemplateSelection)
        self.generate_tool_call = dspy.Predict(ToolCallGeneration)
        self.generate_response = dspy.Predict(ResponseGeneration)
    
    def forward(self, user_request: str):
        # Step 1: Select template
        selection = self.select_template(user_request=user_request)
        
        # If clarification needed, return early
        if selection.selected_template == "clarify":
            return dspy.Prediction(
                selected_template="clarify",
                reasoning=selection.reasoning,
                clarifying_question=selection.clarifying_question,
                tool_call=None,
                response=selection.clarifying_question
            )
        
        # If no match, return with explanation
        if selection.selected_template == "none":
            return dspy.Prediction(
                selected_template="none",
                reasoning=selection.reasoning,
                clarifying_question="",
                tool_call=None,
                response=f"I don't have a template that matches your request. {selection.reasoning}"
            )
        
        # Step 2: Generate tool call
        tool_call = self.generate_tool_call(
            user_request=user_request,
            selected_template=selection.selected_template
        )
        
        # Step 3: Generate response (assuming success for now)
        response = self.generate_response(
            user_request=user_request,
            template=selection.selected_template,
            setup_success=True
        )
        
        return dspy.Prediction(
            selected_template=selection.selected_template,
            reasoning=selection.reasoning,
            clarifying_question="",
            tool_call={
                "name": tool_call.tool_name,
                "params": {
                    "template": tool_call.template_param,
                    "name": tool_call.name_param,
                    **({"theme": tool_call.theme_param} if tool_call.theme_param else {})
                }
            },
            response=response.response
        )


# Simpler module for just template selection (faster to optimize)
class TemplateSelector(dspy.Module):
    """Focused module for just template selection optimization."""
    
    def __init__(self):
        super().__init__()
        self.select = dspy.ChainOfThought(TemplateSelection)
    
    def forward(self, user_request: str):
        return self.select(user_request=user_request)


# ============================================================
# NEW: Schema Modification Signatures
# ============================================================

class SchemaModificationPlanning(dspy.Signature):
    """Analyze a user request to determine what schema changes are needed.
    
    Given a user request after a template has been set up, determine:
    1. Whether schema changes are needed
    2. What model(s) to modify
    3. What fields to add/modify
    4. The Prisma field types to use
    
    IMPORTANT: 
    - NEVER suggest modifying files in src/generated/ - these are auto-generated
    - ALWAYS modify prisma/schema.prisma for data model changes
    - After schema changes, prisma generate and db push must be run
    """
    
    user_request: str = dspy.InputField(desc="The user's customization request")
    template: str = dspy.InputField(desc="The template that was used (e.g., 'crm', 'inventory')")
    existing_models: str = dspy.InputField(desc="Brief description of existing models in the template")
    
    needs_schema_change: bool = dspy.OutputField(
        desc="True if schema.prisma needs to be modified, False otherwise"
    )
    target_model: str = dspy.OutputField(
        desc="The Prisma model to modify (e.g., 'Contact', 'Product'). Empty if no change needed."
    )
    field_name: str = dspy.OutputField(
        desc="The new field name in camelCase (e.g., 'linkedIn', 'expirationDate'). Empty if no change."
    )
    field_type: str = dspy.OutputField(
        desc="Prisma field type (String, Int, DateTime, Boolean, Float, enum name). Empty if no change."
    )
    is_optional: bool = dspy.OutputField(
        desc="Whether the field should be optional (nullable). Default to True for new fields."
    )
    reasoning: str = dspy.OutputField(
        desc="Brief explanation of the schema change decision"
    )


class SchemaCodeGeneration(dspy.Signature):
    """Generate the Prisma schema code for a field addition.
    
    Given the schema modification plan, generate the exact Prisma code to add.
    
    Rules:
    - Use proper Prisma syntax: fieldName Type @default(value) or fieldName Type?
    - For DateTime fields with defaults, use @default(now())
    - For optional fields, add ? after the type
    - For enums, define the enum first if it doesn't exist
    """
    
    target_model: str = dspy.InputField(desc="The model to modify")
    field_name: str = dspy.InputField(desc="The field name to add")
    field_type: str = dspy.InputField(desc="The Prisma type")
    is_optional: bool = dspy.InputField(desc="Whether the field is optional")
    
    prisma_field_code: str = dspy.OutputField(
        desc="The exact Prisma field line to add (e.g., 'linkedIn String?' or 'priority Priority @default(MEDIUM)')"
    )
    enum_definition: str = dspy.OutputField(
        desc="If an enum is needed, the full enum definition. Empty if not needed."
    )


class UIUpdatePlanning(dspy.Signature):
    """Plan UI updates after a schema change.
    
    After modifying the schema, determine what UI changes are needed to:
    1. Display the new field
    2. Allow editing the new field
    3. Where in the UI to add it
    
    IMPORTANT:
    - UI files are typically in src/routes/index.tsx or src/components/
    - Use Tailwind CSS classes for styling
    - Follow the existing UI patterns in the template
    """
    
    user_request: str = dspy.InputField(desc="The original user request")
    template: str = dspy.InputField(desc="The template being customized")
    field_name: str = dspy.InputField(desc="The new field that was added")
    field_type: str = dspy.InputField(desc="The Prisma type of the field")
    
    needs_ui_update: bool = dspy.OutputField(
        desc="True if UI should be updated to show/edit the field"
    )
    ui_file_to_modify: str = dspy.OutputField(
        desc="The file path to modify (typically 'src/routes/index.tsx')"
    )
    ui_element_type: str = dspy.OutputField(
        desc="Type of UI element to add: 'text-input', 'date-picker', 'select', 'checkbox', 'display-only'"
    )
    display_label: str = dspy.OutputField(
        desc="Human-readable label for the field (e.g., 'LinkedIn Profile', 'Expiration Date')"
    )
    reasoning: str = dspy.OutputField(
        desc="Brief explanation of the UI update plan"
    )


class UnsupportedFeatureDetection(dspy.Signature):
    """Detect if a user request asks for something that cannot be built.
    
    Some features are not supported by the Shogo platform:
    - External API integrations (weather, email services, payment processing)
    - Hardware integrations (barcode scanners, printers)
    - Real-time features (live chat, websockets)
    - Data import/export from external systems
    - Authentication/authorization beyond basic
    
    When detecting unsupported features, the agent should:
    1. Clearly explain the limitation
    2. Suggest alternatives if possible
    3. NOT attempt to build the unsupported feature
    """
    
    user_request: str = dspy.InputField(desc="The user's request")
    
    is_unsupported: bool = dspy.OutputField(
        desc="True if the request includes unsupported features"
    )
    unsupported_feature: str = dspy.OutputField(
        desc="Description of the unsupported feature. Empty if supported."
    )
    explanation: str = dspy.OutputField(
        desc="User-friendly explanation of why this isn't supported"
    )
    alternative_suggestion: str = dspy.OutputField(
        desc="Suggested alternative or workaround. Empty if none."
    )


# ============================================================
# Full Agent Module with Schema + UI Modification
# ============================================================

class ShogoFullAgent(dspy.Module):
    """Complete Shogo agent with template selection, schema modification, and UI updates.
    
    This module handles the full flow:
    1. Template selection
    2. Schema modification planning and execution
    3. UI update planning
    4. Unsupported feature detection
    """
    
    def __init__(self):
        super().__init__()
        self.select_template = dspy.ChainOfThought(TemplateSelection)
        self.detect_unsupported = dspy.Predict(UnsupportedFeatureDetection)
        self.plan_schema = dspy.ChainOfThought(SchemaModificationPlanning)
        self.generate_schema_code = dspy.Predict(SchemaCodeGeneration)
        self.plan_ui = dspy.Predict(UIUpdatePlanning)
    
    def forward(self, user_request: str, template: str = "", existing_models: str = ""):
        # Step 0: Check for unsupported features
        unsupported = self.detect_unsupported(user_request=user_request)
        
        if unsupported.is_unsupported:
            return dspy.Prediction(
                selected_template=template or "none",
                is_unsupported=True,
                unsupported_feature=unsupported.unsupported_feature,
                explanation=unsupported.explanation,
                alternative=unsupported.alternative_suggestion,
                schema_change=None,
                ui_update=None
            )
        
        # Step 1: Select template if not already provided
        if not template:
            selection = self.select_template(user_request=user_request)
            template = selection.selected_template
            
            if template in ["clarify", "none"]:
                return dspy.Prediction(
                    selected_template=template,
                    is_unsupported=False,
                    reasoning=selection.reasoning,
                    clarifying_question=selection.clarifying_question if template == "clarify" else "",
                    schema_change=None,
                    ui_update=None
                )
        
        # Step 2: Plan schema modification
        schema_plan = self.plan_schema(
            user_request=user_request,
            template=template,
            existing_models=existing_models
        )
        
        schema_change = None
        if schema_plan.needs_schema_change:
            # Generate the actual schema code
            schema_code = self.generate_schema_code(
                target_model=schema_plan.target_model,
                field_name=schema_plan.field_name,
                field_type=schema_plan.field_type,
                is_optional=schema_plan.is_optional
            )
            
            schema_change = {
                "model": schema_plan.target_model,
                "field_name": schema_plan.field_name,
                "field_type": schema_plan.field_type,
                "prisma_code": schema_code.prisma_field_code,
                "enum_definition": schema_code.enum_definition,
                "reasoning": schema_plan.reasoning
            }
        
        # Step 3: Plan UI update
        ui_update = None
        if schema_plan.needs_schema_change:
            ui_plan = self.plan_ui(
                user_request=user_request,
                template=template,
                field_name=schema_plan.field_name,
                field_type=schema_plan.field_type
            )
            
            if ui_plan.needs_ui_update:
                ui_update = {
                    "file": ui_plan.ui_file_to_modify,
                    "element_type": ui_plan.ui_element_type,
                    "label": ui_plan.display_label,
                    "reasoning": ui_plan.reasoning
                }
        
        return dspy.Prediction(
            selected_template=template,
            is_unsupported=False,
            schema_change=schema_change,
            ui_update=ui_update
        )


class SchemaModifier(dspy.Module):
    """Focused module for schema modification optimization."""
    
    def __init__(self):
        super().__init__()
        self.plan = dspy.ChainOfThought(SchemaModificationPlanning)
        self.generate = dspy.Predict(SchemaCodeGeneration)
    
    def forward(self, user_request: str, template: str, existing_models: str):
        plan = self.plan(
            user_request=user_request,
            template=template,
            existing_models=existing_models
        )
        
        if not plan.needs_schema_change:
            return dspy.Prediction(
                needs_change=False,
                reasoning=plan.reasoning
            )
        
        code = self.generate(
            target_model=plan.target_model,
            field_name=plan.field_name,
            field_type=plan.field_type,
            is_optional=plan.is_optional
        )
        
        return dspy.Prediction(
            needs_change=True,
            target_model=plan.target_model,
            field_name=plan.field_name,
            field_type=plan.field_type,
            prisma_code=code.prisma_field_code,
            enum_definition=code.enum_definition,
            reasoning=plan.reasoning
        )
