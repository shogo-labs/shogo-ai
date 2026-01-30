# Eval: Ambiguous Requests

**Level:** 3 (Requires Clarification)
**Category:** Template Selection
**Difficulty:** Hard

## Purpose

Test the agent's ability to recognize ambiguous requests and ask appropriate clarifying questions (max 1 question).

---

## Test Case 1: Generic Team Tool

### Input
```
"Build something for my team"
```

### Expected Classification
- **Confidence:** Low
- **Reasoning:** "team" could mean many things - no clear template match

### Expected Behavior
1. Recognize ambiguity
2. Ask ONE clarifying question with concrete options
3. Do NOT guess randomly

### Expected Response Pattern
> "I'd be happy to help! To build the right thing, could you tell me more about what your team needs?
> 
> For example:
> - **Task tracking** - A todo list or kanban board for managing work
> - **Customer management** - A CRM for tracking clients and deals  
> - **Project planning** - A board for organizing project stages
> 
> What's the main thing your team needs to manage?"

### Validation Criteria
- [ ] Did NOT randomly select a template
- [ ] Asked exactly ONE question (not multiple)
- [ ] Provided 2-4 concrete options
- [ ] Options were relevant to "team" context

### Anti-Patterns
- [ ] ❌ Immediately selecting kanban without asking
- [ ] ❌ Asking multiple questions ("What's your team size? What industry?")
- [ ] ❌ Providing no options (just "what do you need?")

---

## Test Case 2: Generic Tracking

### Input
```
"I need to track things"
```

### Expected Classification
- **Confidence:** Very Low
- **Reasoning:** "track things" is maximally ambiguous

### Expected Behavior
1. Recognize this could be ANY template
2. Ask what KIND of things to track
3. Offer clear categories

### Expected Response Pattern
> "I can help you track things! What specifically do you need to track?
> 
> - **Tasks/todos** - Daily work items and checklists
> - **Money/expenses** - Spending and budgets
> - **Customers/sales** - Clients and deals
> - **Inventory/products** - Stock and supplies
> - **Something else** - Tell me more!"

### Validation Criteria
- [ ] Recognized maximum ambiguity
- [ ] Offered diverse template categories
- [ ] Single clarifying question

---

## Test Case 3: Business App (Multiple Valid Options)

### Input
```
"Build a business app"
```

### Expected Classification
- **Confidence:** Low
- **Reasoning:** Multiple templates serve business needs (CRM, inventory, expense-tracker)

### Expected Behavior
Ask which business function to address

### Expected Response Pattern
> "I can build several types of business apps. Which area is most important?
> 
> - **Sales & Customers** (CRM) - Track leads, deals, and client relationships
> - **Inventory & Products** - Manage stock levels and suppliers
> - **Expenses & Budget** - Track business spending
> - **Project Management** (Kanban) - Organize work visually"

### Validation Criteria
- [ ] Recognized "business" maps to multiple templates
- [ ] Offered business-relevant options only
- [ ] Did NOT offer todo-app (too simple for "business app")

---

## Test Case 4: Hybrid Request

### Input
```
"I want to track my tasks and also my spending"
```

### Expected Classification
- **Confidence:** Medium (for each part)
- **Reasoning:** Clearly wants BOTH todo-app AND expense-tracker features

### Expected Behavior
1. Acknowledge both needs
2. Explain current limitation (one template at a time)
3. Ask which to start with

### Expected Response Pattern
> "I can help with both! Currently, I'd set these up as separate apps:
> 
> - **Todo app** for tracking tasks
> - **Expense tracker** for monitoring spending
> 
> Which would you like me to build first? I can add the other one after."

### Validation Criteria
- [ ] Recognized BOTH needs explicitly
- [ ] Did NOT try to force one template
- [ ] Offered to do both sequentially
- [ ] Let user choose priority

---

## Test Case 5: Novel Request (No Template)

### Input
```
"Build me a recipe manager"
```

### Expected Classification
- **Confidence:** Low/None
- **Reasoning:** No recipe-specific template exists

### Expected Behavior
1. Acknowledge no exact template
2. Suggest closest option OR offer custom
3. Do NOT pretend a template exists

### Expected Response Pattern
> "I don't have a recipe-specific template, but I could:
> 
> 1. **Adapt the inventory template** - It has items, categories, and quantities which could work for ingredients and recipes
> 2. **Build something custom** - Create a recipe app from scratch
> 
> Which approach would you prefer?"

### Validation Criteria
- [ ] Honestly stated no recipe template exists
- [ ] Offered reasonable alternatives
- [ ] Did NOT lie about template availability

---

## Scoring Rubric

| Criterion | Points |
|-----------|--------|
| Recognized ambiguity correctly | 25 |
| Asked exactly ONE question | 25 |
| Provided relevant options | 25 |
| Options were concrete and helpful | 15 |
| Professional tone | 10 |
| **Total** | **100** |

---

## Boundary Cases

### Slightly Ambiguous (Should Still Proceed)

**Input:** "Todo list app with categories"
**Expected:** Proceed with todo-app (clear enough, categories can be added)

**Input:** "Simple expense app"  
**Expected:** Proceed with expense-tracker (clear enough)

### Clearly Ambiguous (Must Clarify)

**Input:** "App for my work"
**Expected:** Ask - too vague

**Input:** "Something to help me"
**Expected:** Ask - no useful information
