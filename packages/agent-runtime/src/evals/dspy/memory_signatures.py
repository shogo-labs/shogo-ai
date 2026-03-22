"""Memory track DSPy signatures."""

import dspy


class MemoryWriteDecision(dspy.Signature):
    """Decide whether the current conversation warrants a memory write.

    Write to memory when:
    - User shares significant personal info (name, preferences, timezone)
    - A multi-step task completes with notable results
    - Agent discovers useful patterns about the user

    Do NOT write when:
    - The conversation is trivial (greeting, quick Q&A)
    - The information is already in MEMORY.md
    - The task is mechanical (file conversion, formatting)
    """
    conversation_summary: str = dspy.InputField(desc="Summary of the current conversation turn")
    tools_used: str = dspy.InputField(desc="Comma-separated list of tools used this turn")
    current_memory: str = dspy.InputField(desc="Current contents of MEMORY.md (first 500 chars)")

    should_write: bool = dspy.OutputField(desc="True if memory write is warranted")
    target_file: str = dspy.OutputField(desc="'MEMORY.md' for permanent, 'YYYY-MM-DD' for daily log")
    content: str = dspy.OutputField(desc="Concise memory entry under 100 words")
    reasoning: str = dspy.OutputField()


class MemoryRetrieval(dspy.Signature):
    """Decide the best memory retrieval strategy for a user message.

    Use memory_read when: you know the exact file (MEMORY.md or a date).
    Use memory_search when: you need to find info across multiple entries.
    Use neither when: the answer is in the current session history.
    """
    user_message: str = dspy.InputField(desc="The user's current message")
    has_session_context: bool = dspy.InputField(desc="True if the answer might be in recent session history")

    tool_to_use: str = dspy.OutputField(desc="'memory_read', 'memory_search', or 'none'")
    query_or_file: str = dspy.OutputField(desc="The file path for memory_read, or search query for memory_search, or empty")
    reasoning: str = dspy.OutputField()
