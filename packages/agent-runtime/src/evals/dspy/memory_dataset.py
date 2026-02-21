"""Memory track training dataset — loaded from fixtures/memory.json.

Two subtypes:
  - 'write': Should we write to memory? (MemoryWriteDecision)
  - 'retrieval': Which retrieval strategy? (MemoryRetrieval)
"""

import dspy
from load_fixtures import load_fixture, get_examples


def _split(examples, ratio=0.7):
    n = max(1, int(len(examples) * ratio))
    return examples[:n], examples[n:]


def get_memory_dataset() -> dict[str, tuple[list[dspy.Example], list[dspy.Example]]]:
    fixture = load_fixture("memory")

    write_examples = []
    retrieval_examples = []

    for ex in get_examples(fixture):
        is_retrieval = ex["expected_retrieval_tool"] not in ("none", "")

        if is_retrieval:
            retrieval_examples.append(dspy.Example(
                user_message=ex["user_message"],
                has_session_context=ex["has_session_context"],
                tool_to_use=ex["expected_retrieval_tool"],
                query_or_file=ex["expected_retrieval_query"],
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("user_message", "has_session_context"))
        else:
            write_examples.append(dspy.Example(
                conversation_summary=ex["conversation_summary"],
                tools_used=", ".join(ex["tools_used"]),
                current_memory=ex["current_memory"],
                should_write=ex["expected_write"],
                target_file=ex["expected_target_file"],
                content=ex["expected_content"],
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("conversation_summary", "tools_used", "current_memory"))

    result = {"write": _split(write_examples)}
    if retrieval_examples:
        result["retrieval"] = _split(retrieval_examples)
    return result
