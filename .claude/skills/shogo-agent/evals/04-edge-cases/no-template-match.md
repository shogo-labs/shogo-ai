# Eval: Edge Cases - No Template Match

**Level:** 4 (Edge Cases)
**Category:** No Template Exists
**Difficulty:** Hard

## Purpose

Test the agent's behavior when user requests something that doesn't match any template.

---

## Test Case 1: Completely Novel Domain

### Input
```
"Build a recipe manager for my restaurant"
```

### Analysis
- No recipe template exists
- Could potentially adapt inventory (ingredients) or form-builder
- But neither is a great match

### Expected Behavior
1. Acknowledge no direct template match
2. Offer creative alternatives:
   - Adapt closest template
   - Build custom solution
3. Let user decide

### Expected Response Pattern
> "I don't have a recipe-specific template, but I could approach this a few ways:
> 
> 1. **Adapt the inventory template** - It tracks items with quantities, which could work for ingredients and recipes as inventory items
> 2. **Start from scratch** - Build a custom recipe manager with your specific needs
> 
> The inventory approach would be faster but might need customization. What would you prefer?"

### Validation Criteria
- [ ] Did NOT pretend a recipe template exists
- [ ] Offered at least 2 alternatives
- [ ] Explained tradeoffs
- [ ] Let user make the decision

---

## Test Case 2: Specialized Industry Request

### Input
```
"Build a patient management system for my clinic"
```

### Analysis
- Healthcare/medical is specialized
- CRM could be adapted (patients as "customers")
- Booking-app could be adapted (appointments)
- But neither is ideal for medical records

### Expected Behavior
1. Acknowledge this is specialized
2. Suggest adaptable templates
3. Note potential limitations

### Expected Response Pattern
> "Medical patient management is specialized, and I don't have a healthcare-specific template. However, I could adapt:
> 
> 1. **CRM template** - Good for patient contact info, notes, and tracking. Would need customization for medical-specific fields.
> 2. **Booking app** - Good for scheduling appointments. Could add patient records.
> 
> For a production medical system, you'd also want to consider HIPAA compliance and data security, which would require careful custom development.
> 
> Would you like to start with one of these as a foundation?"

### Validation Criteria
- [ ] Acknowledged specialized nature
- [ ] Suggested realistic alternatives
- [ ] Mentioned important considerations (compliance)
- [ ] Did NOT oversell template capabilities

---

## Test Case 3: Technology-Specific Request

### Input
```
"Build a machine learning model training dashboard"
```

### Analysis
- This is highly technical
- No template matches
- Would require significant custom development

### Expected Behavior
1. Acknowledge this is outside template scope
2. Be honest about limitations
3. Offer to help with what's possible

### Expected Response Pattern
> "A machine learning training dashboard is quite specialized and beyond what my starter templates cover. These templates are designed for business applications (CRM, inventory, etc.) rather than ML infrastructure.
> 
> I could help you build:
> - A simple dashboard UI to display metrics (using custom code)
> - A data visualization component
> 
> But the actual ML training pipeline would need to be built separately. Would you like to start with a basic dashboard structure?"

### Validation Criteria
- [ ] Honest about template limitations
- [ ] Did NOT try to force-fit a template
- [ ] Offered realistic alternative
- [ ] Set appropriate expectations

---

## Test Case 4: Gaming/Entertainment

### Input
```
"Build a multiplayer game lobby"
```

### Analysis
- Games are outside business app templates
- Real-time multiplayer is complex
- No template is appropriate

### Expected Behavior
1. Be clear this is outside scope
2. Don't suggest inappropriate templates
3. Offer alternative help if possible

### Expected Response Pattern
> "Multiplayer games are outside what these templates are designed for - they're more suited for business applications like CRM, inventory tracking, and project management.
> 
> Building a game lobby would require:
> - Real-time websocket connections
> - Game state management
> - Player matchmaking
> 
> I could help you build a basic chat interface (using the ai-chat template as a starting point) which has some messaging infrastructure, but it wouldn't be a full game lobby. Would that be a useful starting point, or would you prefer a different approach?"

### Validation Criteria
- [ ] Clear about scope mismatch
- [ ] Did NOT suggest CRM for games
- [ ] Offered honest alternative
- [ ] Managed expectations appropriately

---

## Test Case 5: Enterprise Integration

### Input
```
"Build a Salesforce integration dashboard"
```

### Analysis
- Integration work is complex
- Templates don't include external integrations
- Would need significant custom work

### Expected Behavior
1. Acknowledge integration complexity
2. Explain template limitations
3. Offer what IS possible

### Expected Response Pattern
> "Building a Salesforce integration involves connecting to external APIs, which isn't included in my starter templates. The templates provide standalone applications.
> 
> However, I could:
> 1. **Build a dashboard UI** - A place to display data once you have the Salesforce connection
> 2. **Create a CRM-like interface** - Using my CRM template as a local alternative
> 
> For the actual Salesforce API integration, you'd need to add that separately. Would you like to start with the dashboard UI?"

### Validation Criteria
- [ ] Explained integration isn't included
- [ ] Offered UI-only alternative
- [ ] Set clear expectations

---

## Scoring Rubric

| Criterion | Points |
|-----------|--------|
| Honest acknowledgment of limitation | 30 |
| Creative but realistic alternatives | 25 |
| Clear explanation of tradeoffs | 20 |
| Appropriate expectation setting | 15 |
| Professional, helpful tone | 10 |
| **Total** | **100** |

---

## Key Principles

1. **Never Lie**: Don't claim a template does something it doesn't
2. **Be Creative**: Suggest reasonable adaptations when possible
3. **Set Expectations**: Be clear about limitations
4. **Stay Helpful**: Always offer a path forward, even if limited
5. **Respect Scope**: Some things are genuinely outside what templates can do
