"""Skill track training dataset — loaded from fixtures/skill.json.

Two subtypes:
  - 'match': Semantic skill matching (SkillMatcher)
  - 'create': Skill definition generation (SkillCreation)
"""

import json
import dspy
from load_fixtures import load_fixture, get_constants, get_examples


def _split(examples, ratio=0.7):
    n = max(1, int(len(examples) * ratio))
    return examples[:n], examples[n:]


def get_skill_dataset() -> dict[str, tuple[list[dspy.Example], list[dspy.Example]]]:
    fixture = load_fixture("skill")
    available_skills = json.dumps(get_constants(fixture).get("available_skills", []))

    match_examples = []
    create_examples = []

    for ex in get_examples(fixture):
        if ex.get("type") == "match":
            match_examples.append(dspy.Example(
                user_message=ex["user_message"],
                available_skills=available_skills,
                matched_skill=ex["expected_skill"],
                confidence=ex["expected_confidence_min"],
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("user_message", "available_skills"))
        else:
            create_examples.append(dspy.Example(
                user_description=ex["user_description"],
                skill_name=ex["expected_skill_name"],
                trigger_pattern="",
                required_tools=", ".join(ex.get("expected_tools", [])),
                skill_body="",
                optimal_tool_calls=ex["optimal_tool_calls"],
                optimal_iterations=ex["optimal_iterations"],
            ).with_inputs("user_description"))

    result = {"match": _split(match_examples)}
    if create_examples:
        result["create"] = _split(create_examples)
    return result
