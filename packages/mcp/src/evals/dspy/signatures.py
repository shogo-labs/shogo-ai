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
