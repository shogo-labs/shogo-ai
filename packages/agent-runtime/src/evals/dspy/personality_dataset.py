"""Personality track training dataset — loaded from fixtures/personality.json.

Two subtypes:
  - 'selection': Template matching (AgentTemplateSelection)
  - 'self_update': Personality self-update decisions (PersonalitySelfUpdate)
"""

import json
import dspy
from load_fixtures import load_fixture, get_constants, get_examples


def _split(examples, ratio=0.7):
    n = max(1, int(len(examples) * ratio))
    return examples[:n], examples[n:]


def get_personality_dataset() -> dict[str, tuple[list[dspy.Example], list[dspy.Example]]]:
    fixture = load_fixture("personality")
    templates = get_constants(fixture).get("available_templates", [])
    available_templates_json = json.dumps(templates)

    selection_examples = []
    self_update_examples = []

    for ex in get_examples(fixture):
        is_self_update = ex.get("type") == "self-update"

        if is_self_update:
            self_update_examples.append(dspy.Example(
                conversation_summary=ex.get("conversation_summary", ""),
                current_soul=ex.get("current_soul", ""),
                should_update=ex.get("expected_should_update", False),
                file=ex.get("expected_file", ""),
                section=ex.get("expected_section", ""),
                new_content="",
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("conversation_summary", "current_soul"))
        else:
            selection_examples.append(dspy.Example(
                user_description=ex.get("user_description", ""),
                available_templates=available_templates_json,
                template_id=ex.get("expected_template_id", ""),
                confidence=ex.get("expected_confidence_min", 0.0),
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("user_description", "available_templates"))

    result = {"selection": _split(selection_examples)}
    if self_update_examples:
        result["self_update"] = _split(self_update_examples)
    return result
