"""Personality track DSPy signatures."""

import dspy


class AgentTemplateSelection(dspy.Signature):
    """Select the best agent template for a user description.

    Available templates (20+):
    - personal-assistant, code-buddy, writing-coach, fitness-tracker, meal-planner
    - github-monitor, ci-cd-manager, code-reviewer, devops-helper, api-tester
    - sales-tracker, customer-support, marketing-analyst, hr-assistant
    - research-agent, academic-helper, market-researcher, patent-analyzer
    - system-monitor, log-analyzer, incident-responder, deploy-manager

    If the user's description closely matches a template, return that template.
    If it's a semantic match (e.g. "help me with code reviews" -> code-reviewer), infer it.
    If ambiguous, return "custom" to indicate manual setup.
    """
    user_description: str = dspy.InputField(desc="User's description of the agent they want")
    available_templates: str = dspy.InputField(desc="JSON array of {id, name, description, category}")

    template_id: str = dspy.OutputField(desc="Template ID or 'custom'")
    confidence: float = dspy.OutputField(desc="0.0-1.0 confidence in the match")
    reasoning: str = dspy.OutputField()


class PersonalityGeneration(dspy.Signature):
    """Generate the Personality section of AGENTS.md for an agent.

    The Personality section in AGENTS.md defines the agent's tone, and behavioral boundaries.
    It must include:
    - A clear persona description
    - Tone (verbosity, formality)
    - Boundaries section (what the agent should NOT do)
    - Domain expertise areas

    The personality must NOT be generic "helpful assistant" — it should be
    specific to the agent type and user's needs.
    """
    template_name: str = dspy.InputField(desc="Template ID or 'custom'")
    user_description: str = dspy.InputField(desc="User's description of desired agent behavior")
    agent_type: str = dspy.InputField(desc="Category: personal, development, business, research, operations")

    soul_content: str = dspy.OutputField(desc="Full Personality section markdown content for AGENTS.md")
    has_boundaries: bool = dspy.OutputField(desc="True if Boundaries section is included")
    reasoning: str = dspy.OutputField()


class PersonalitySelfUpdate(dspy.Signature):
    """Decide if the agent should update its AGENTS.md based on conversation.

    AGENTS.md contains Identity, Personality, User, and Operating Instructions sections.

    Update when:
    - User explicitly corrects the agent's tone ("be more formal")
    - User establishes a new boundary ("don't suggest code changes")
    - Agent discovers a pattern that should be permanent

    Do NOT update when:
    - Trivial conversation (greeting, quick question)
    - One-off request that doesn't reflect a lasting preference
    - The same info is already in AGENTS.md
    """
    conversation_summary: str = dspy.InputField(desc="Summary of the conversation that may warrant an update")
    current_soul: str = dspy.InputField(desc="Current AGENTS.md Personality section content")

    should_update: bool = dspy.OutputField(desc="True if a personality update is warranted")
    file: str = dspy.OutputField(desc="Always 'AGENTS.md'")
    section: str = dspy.OutputField(desc="Section heading to update, e.g. 'Tone', 'Boundaries', 'Identity'")
    new_content: str = dspy.OutputField(desc="New content for that section")
    reasoning: str = dspy.OutputField(desc="Why this update improves agent behavior")
