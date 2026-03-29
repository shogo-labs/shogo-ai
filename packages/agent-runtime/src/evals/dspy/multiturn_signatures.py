"""Multi-turn conversation planning track DSPy signatures."""

import dspy


class ConversationPlanner(dspy.Signature):
    """Plan the full tool sequence for a user request before executing.

    The key optimization: plan all tool calls upfront so the agent
    completes complex tasks in fewer LLM iterations rather than
    discovering the next step after each tool result.

    The agent loop (agent-loop.ts) runs up to 10 iterations per turn.
    Each iteration can produce multiple tool calls. Batching tool calls
    into fewer iterations is rewarded.
    """
    user_message: str = dspy.InputField(desc="The user's current request")
    conversation_history_summary: str = dspy.InputField(desc="Compacted summary of prior turns")
    available_tools: str = dspy.InputField(
        desc="Tool names and descriptions: exec, read_file, write_file, web, "
             "memory_read, memory_search, browser, send_message, cron, "
             "canvas_create, canvas_update, canvas_data, canvas_delete, canvas_action_wait, "
             "canvas_components, canvas_api_schema, canvas_api_seed, canvas_api_query"
    )

    planned_tool_sequence: str = dspy.OutputField(
        desc="Ordered comma-separated list of tool calls needed, e.g. 'read_file, write_file'"
    )
    estimated_iterations: int = dspy.OutputField(desc="Expected LLM round-trips (usually 1)")
    can_batch: bool = dspy.OutputField(
        desc="True if multiple tools can run in a single iteration (independent calls)"
    )
    reasoning: str = dspy.OutputField()


class SessionSummarizer(dspy.Signature):
    """Summarize conversation messages preserving key context for future turns.

    Replace the crude 200-char fallback truncation with a proper summary.
    This feeds into sessionManager.setSummarizeFn().

    The summary must preserve:
    - User name, timezone, and preferences
    - Key decisions made
    - Important facts and outcomes
    - Active tasks or pending actions

    It must discard:
    - Verbose tool output details
    - Repetitive heartbeat checks
    - Greeting/small-talk content
    """
    messages_text: str = dspy.InputField(desc="Stringified messages to compact")

    summary: str = dspy.OutputField(desc="Concise summary under 200 words")
    key_facts: str = dspy.OutputField(desc="Bullet list of facts to preserve across sessions")
    user_preferences: str = dspy.OutputField(desc="User preferences discovered in this conversation")
