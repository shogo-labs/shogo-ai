# Eval: Direct Match - CRM

**Level:** 1 (Direct Mapping)
**Category:** Template Selection
**Difficulty:** Easy

## Input

```
"Build a CRM for my business"
```

## Expected Classification

- **Template:** crm
- **Confidence:** High (exact keyword match)
- **Reasoning:** "CRM" is an exact keyword match

## Expected Tool Calls

1. `template.copy({ template: "crm", name: "<derived-name>" })`

## Expected Response Pattern

> "I'll set up a CRM for your business."
> 
> [Calls template.copy]
> 
> "Your CRM is ready! It includes contact management, deal tracking, and a sales pipeline view. Would you like me to customize the deal stages, add custom fields, or modify the layout?"

## Validation Criteria

- [ ] Selected crm template
- [ ] Called template.copy correctly
- [ ] Mentioned key CRM features (contacts, deals, pipeline)
- [ ] Offered relevant customization options

## Variations

All should select crm template:

1. "Customer relationship management system"
2. "I need to track my sales leads"
3. "Build a customer database"
4. "Sales pipeline app"
5. "Lead management system"
6. "Contact management for sales"

## Scoring

| Criterion | Points |
|-----------|--------|
| Correct template (crm) | 40 |
| No unnecessary questions | 20 |
| Proper tool usage | 20 |
| Mentions CRM features | 10 |
| Offers customization | 10 |
| **Total** | **100** |

## Related Template Confusion Test

**Input:** "I need to manage customer information"

**Expected:** crm (not inventory, which also has "management")

**Input:** "Track contacts and their purchases"

**Expected:** crm (contacts are the key indicator)
