"""
Evaluation Metrics for DSPy Optimization

These metrics are used by DSPy optimizers to evaluate and improve the agent.
"""

import dspy
from typing import Optional


# Valid templates for validation
VALID_TEMPLATES = {
    "todo-app", "expense-tracker", "crm", "inventory", "kanban",
    "ai-chat", "form-builder", "feedback-form", "booking-app",
    "clarify", "none"
}

# Related templates (for partial credit)
RELATED_TEMPLATES = {
    "todo-app": {"kanban"},  # Both handle tasks
    "kanban": {"todo-app"},
    "expense-tracker": {"inventory"},  # Both track items
    "inventory": {"expense-tracker"},
    "crm": {"booking-app"},  # Both handle clients
    "booking-app": {"crm"},
    "form-builder": {"feedback-form"},  # Both handle forms
    "feedback-form": {"form-builder"},
}


def template_accuracy(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Measure if the correct template was selected.
    
    Returns:
        1.0 if exact match
        0.5 if related template (partial credit)
        0.0 if wrong template
    """
    expected = example.selected_template.lower().strip()
    predicted = prediction.selected_template.lower().strip()
    
    # Exact match
    if predicted == expected:
        return 1.0
    
    # Partial credit for related templates
    related = RELATED_TEMPLATES.get(expected, set())
    if predicted in related:
        return 0.5
    
    # Special case: if expected is "clarify" and predicted is valid template,
    # give small credit (better to try than to ask unnecessarily)
    if expected == "clarify" and predicted in VALID_TEMPLATES:
        return 0.25
    
    return 0.0


def no_unnecessary_clarification(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Penalize asking clarifying questions when the request was clear.
    
    Returns:
        1.0 if appropriately handled (clear request → action, ambiguous → clarify)
        0.0 if asked when shouldn't have or didn't ask when should have
    """
    expected = example.selected_template.lower().strip()
    predicted = prediction.selected_template.lower().strip()
    
    # If expected is a real template (not clarify/none), agent shouldn't ask
    expected_is_clear = expected not in {"clarify", "none"}
    predicted_asked = predicted == "clarify" or bool(prediction.clarifying_question.strip())
    
    if expected_is_clear and predicted_asked:
        # Asked when shouldn't have
        return 0.0
    elif not expected_is_clear and not predicted_asked:
        # Didn't ask when should have
        return 0.0
    else:
        # Appropriate behavior
        return 1.0


def reasoning_quality(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Evaluate the quality of the reasoning provided.
    
    Returns score 0-1 based on:
    - Reasoning is present and non-empty
    - Reasoning mentions relevant keywords
    - Reasoning is concise (not too long)
    """
    reasoning = prediction.reasoning.lower().strip()
    
    if not reasoning:
        return 0.0
    
    score = 0.0
    
    # Has some reasoning
    score += 0.3
    
    # Check if reasoning mentions the template or relevant keywords
    template = prediction.selected_template.lower()
    if template in reasoning or any(word in reasoning for word in template.split("-")):
        score += 0.3
    
    # Check if reasoning is appropriate length (not too short or long)
    word_count = len(reasoning.split())
    if 5 <= word_count <= 50:
        score += 0.2
    elif word_count > 0:
        score += 0.1
    
    # Check if reasoning explains the match
    match_indicators = ["match", "because", "since", "maps to", "indicates", "suggests"]
    if any(indicator in reasoning for indicator in match_indicators):
        score += 0.2
    
    return min(score, 1.0)


def combined_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """
    Combined metric with weighted components.
    
    Weights:
    - Template accuracy: 50%
    - No unnecessary clarification: 30%
    - Reasoning quality: 20%
    """
    acc = template_accuracy(example, prediction, trace)
    no_clarify = no_unnecessary_clarification(example, prediction, trace)
    reasoning = reasoning_quality(example, prediction, trace)
    
    return (acc * 0.5) + (no_clarify * 0.3) + (reasoning * 0.2)


def strict_accuracy(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> bool:
    """
    Strict pass/fail metric - exact template match required.
    Used for simple evaluation, not optimization.
    """
    expected = example.selected_template.lower().strip()
    predicted = prediction.selected_template.lower().strip()
    return predicted == expected


class AgentMetrics:
    """Aggregated metrics for tracking optimization progress."""
    
    def __init__(self):
        self.results = []
    
    def add_result(self, example, prediction):
        self.results.append({
            "expected": example.selected_template,
            "predicted": prediction.selected_template,
            "accuracy": template_accuracy(example, prediction),
            "no_clarify": no_unnecessary_clarification(example, prediction),
            "reasoning": reasoning_quality(example, prediction),
            "combined": combined_metric(example, prediction),
        })
    
    def summary(self):
        if not self.results:
            return {}
        
        n = len(self.results)
        return {
            "total": n,
            "exact_matches": sum(1 for r in self.results if r["accuracy"] == 1.0),
            "partial_matches": sum(1 for r in self.results if 0 < r["accuracy"] < 1.0),
            "avg_accuracy": sum(r["accuracy"] for r in self.results) / n,
            "avg_no_clarify": sum(r["no_clarify"] for r in self.results) / n,
            "avg_reasoning": sum(r["reasoning"] for r in self.results) / n,
            "avg_combined": sum(r["combined"] for r in self.results) / n,
        }
    
    def print_summary(self):
        s = self.summary()
        if not s:
            print("No results yet")
            return
        
        print(f"\n{'='*50}")
        print("METRICS SUMMARY")
        print(f"{'='*50}")
        print(f"Total examples:     {s['total']}")
        print(f"Exact matches:      {s['exact_matches']} ({s['exact_matches']/s['total']*100:.1f}%)")
        print(f"Partial matches:    {s['partial_matches']}")
        print(f"Avg accuracy:       {s['avg_accuracy']:.3f}")
        print(f"Avg no-clarify:     {s['avg_no_clarify']:.3f}")
        print(f"Avg reasoning:      {s['avg_reasoning']:.3f}")
        print(f"Avg combined:       {s['avg_combined']:.3f}")
        print(f"{'='*50}\n")


# For testing metrics
if __name__ == "__main__":
    # Test with mock data
    example = dspy.Example(
        user_request="Build a todo app",
        selected_template="todo-app",
        reasoning="Direct match",
        clarifying_question=""
    )
    
    # Correct prediction
    pred_correct = dspy.Prediction(
        selected_template="todo-app",
        reasoning="User said 'todo' which directly maps to todo-app template",
        clarifying_question=""
    )
    
    # Wrong prediction
    pred_wrong = dspy.Prediction(
        selected_template="kanban",
        reasoning="Tasks could use a board",
        clarifying_question=""
    )
    
    # Unnecessary clarification
    pred_clarify = dspy.Prediction(
        selected_template="clarify",
        reasoning="Need more info",
        clarifying_question="What kind of tasks?"
    )
    
    print("Correct prediction:")
    print(f"  Accuracy: {template_accuracy(example, pred_correct)}")
    print(f"  No clarify: {no_unnecessary_clarification(example, pred_correct)}")
    print(f"  Combined: {combined_metric(example, pred_correct)}")
    
    print("\nWrong prediction (related template):")
    print(f"  Accuracy: {template_accuracy(example, pred_wrong)}")
    print(f"  Combined: {combined_metric(example, pred_wrong)}")
    
    print("\nUnnecessary clarification:")
    print(f"  Accuracy: {template_accuracy(example, pred_clarify)}")
    print(f"  No clarify: {no_unnecessary_clarification(example, pred_clarify)}")
    print(f"  Combined: {combined_metric(example, pred_clarify)}")
