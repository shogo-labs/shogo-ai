---
name: contact-lookup
version: 1.0.0
description: Look up contact information from the workspace contacts file or memory
trigger: "find contact|who is|contact info|look up person|contact for"
tools: [read_file, memory_search]
---

# Contact Lookup

When the user asks about a contact:

1. Search contacts.md in the workspace (if it exists)
2. Search MEMORY.md for any stored contact information
3. Present matching contact details

## Expected contacts.md Format

```markdown
# Contacts

## [Name]
- **Email:** email@example.com
- **Phone:** +1-555-0123
- **Company:** Company Name
- **Role:** Job Title
- **Notes:** Last spoke on [date] about [topic]
```

If no contacts file exists, suggest creating one and offer to help set it up.
