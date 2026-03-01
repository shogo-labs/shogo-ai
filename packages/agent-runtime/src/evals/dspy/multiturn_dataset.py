"""Multi-turn planning track training dataset — loaded from fixtures/multiturn.json.

Two subtypes:
  - 'plan': Tool sequence planning (ConversationPlanner)
  - 'summarize': Session summarization (SessionSummarizer)
"""

import dspy
from load_fixtures import load_fixture, get_constants, get_examples


def _split(examples, ratio=0.7):
    n = max(1, int(len(examples) * ratio))
    return examples[:n], examples[n:]


def get_multiturn_dataset() -> dict[str, tuple[list[dspy.Example], list[dspy.Example]]]:
    fixture = load_fixture("multiturn")
    available_tools = get_constants(fixture).get("available_tools", "")

    plan_examples = []
    summarize_examples = []

    for ex in get_examples(fixture):
        if ex.get("type") == "plan":
            plan_examples.append(dspy.Example(
                user_message=ex["user_message"],
                conversation_history_summary=ex.get("conversation_history_summary", ""),
                available_tools=available_tools,
                planned_tool_sequence=", ".join(ex["expected_tool_sequence"]),
                estimated_iterations=ex["expected_iterations"],
                can_batch=ex["expected_can_batch"],
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("user_message", "conversation_history_summary", "available_tools"))
        else:
            summarize_examples.append(dspy.Example(
                messages_text=ex["messages_text"],
                summary="",
                key_facts="\n".join(f"- {f}" for f in ex.get("expected_key_facts", [])),
                user_preferences=", ".join(ex.get("expected_user_preferences", [])),
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("messages_text"))

    result = {"plan": _split(plan_examples)}
    if summarize_examples:
        result["summarize"] = _split(summarize_examples)
    return result
