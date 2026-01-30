# Eval: Direct Match - Expense Tracker

**Level:** 1 (Direct Mapping)
**Category:** Template Selection
**Difficulty:** Easy

## Input

```
"Build an expense tracker"
```

## Expected Classification

- **Template:** expense-tracker
- **Confidence:** High (exact keyword match)
- **Reasoning:** "expense tracker" directly matches expense-tracker template

## Expected Tool Calls

1. `template.copy({ template: "expense-tracker", name: "<derived-name>" })`

## Expected Response Pattern

The response should:
1. Acknowledge building an expense tracker
2. Use the expense-tracker template
3. Report successful setup
4. Mention key features (categories, transactions)
5. Offer to customize

**Example:**
> "I'll create an expense tracker for you."
> 
> [Calls template.copy]
> 
> "Your expense tracker is ready! It includes categories for organizing expenses and transaction tracking. Would you like me to add custom categories, change the currency display, or add any other features?"

## Validation Criteria

- [ ] Selected expense-tracker template (not todo-app)
- [ ] Called template.copy with template: "expense-tracker"
- [ ] Did NOT confuse with todo-app (both track things)
- [ ] Did NOT ask unnecessary questions
- [ ] Completed setup before declaring success

## Anti-Patterns

- [ ] ❌ Selecting todo-app because "tracking" was mentioned
- [ ] ❌ Asking "Do you want to track expenses or tasks?"
- [ ] ❌ Building a custom solution

## Variations

Test these equivalent requests - all should select expense-tracker:

1. "Create a budget app"
2. "I need to track my spending"
3. "Build me a finance tracker"
4. "Money management app"
5. "Help me track expenses"
6. "Personal budget tracker"

## Scoring

| Criterion | Points |
|-----------|--------|
| Correct template (expense-tracker) | 40 |
| No unnecessary questions | 20 |
| Proper tool usage | 20 |
| Good response quality | 10 |
| Offers customization | 10 |
| **Total** | **100** |

## Disambiguation Test

**Input:** "Track my daily expenses and tasks"

**Expected Behavior:**
- Recognize ambiguity (expenses AND tasks)
- Ask ONE clarifying question
- "Would you like a combined app, or should I start with expense tracking?"

This tests the agent's ability to recognize when a request spans multiple templates.
