"""Canvas track training dataset — loaded from fixtures/canvas.json.

Two subtypes:
  - 'planning': Plan-only evaluation (CanvasPlanning)
  - 'e2e': Full execution — model generates component tree + data,
           which is executed against real DynamicAppManager (CanvasE2E)
"""

import dspy
from load_fixtures import load_fixture, get_constants, get_examples


def _split(examples, ratio=0.7):
    n = max(1, int(len(examples) * ratio))
    return examples[:n], examples[n:]


def get_canvas_dataset() -> dict[str, tuple[list[dspy.Example], list[dspy.Example]]]:
    fixture = load_fixture("canvas")
    available_components = get_constants(fixture).get("available_components", "")

    planning = []
    e2e = []

    for ex in get_examples(fixture):
        # Planning sub-track (existing)
        planning.append(dspy.Example(
            user_request=ex["user_request"],
            available_components=available_components,
            needs_api_schema=ex["needs_api_schema"],
            surface_id=ex["surface_id"],
            tool_sequence=", ".join(ex["tool_sequence"]),
            component_types=", ".join(ex["component_types"]),
            optimal_tool_calls=ex["optimal_tool_calls"],
            optimal_iterations=ex["optimal_iterations"],
            component_count=ex["component_count"],
        ).with_inputs("user_request", "available_components"))

        # E2E sub-track — same input, but the model must produce
        # actual executable artifacts (component tree, data payload)
        e2e.append(dspy.Example(
            user_request=ex["user_request"],
            available_components=available_components,
            needs_api_schema=ex["needs_api_schema"],
            expected_component_count=ex["component_count"],
            expected_component_types=", ".join(ex["component_types"]),
            surface_id=ex["surface_id"],
            component_tree_json="",
            data_payload_json="",
            api_models_json="[]",
            api_seed_json="{}",
            optimal_tool_calls=ex["optimal_tool_calls"],
            optimal_iterations=ex["optimal_iterations"],
        ).with_inputs("user_request", "available_components"))

    return {
        "planning": _split(planning),
        "e2e": _split(e2e),
    }
