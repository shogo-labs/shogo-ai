---
name: write-email
version: 1.0.0
description: Draft professional emails based on context and user instructions
trigger: "draft email|compose email|write email|email to|send email"
tools: [write_file, memory_search]
---

# Write Email

When asked to draft an email:

1. Determine recipient, subject, and key points from user's request
2. Check MEMORY.md for any context about the recipient
3. Draft the email in the appropriate tone
4. Save draft to workspace for review

## Guidelines
- Match formality to the relationship (check contacts/memory for context)
- Keep emails concise — aim for 5 sentences or less
- Include clear call-to-action
- Use professional formatting

## Output Format

**To:** [Recipient]
**Subject:** [Subject line]

---

[Email body]

---

*Saved as draft. Review and let me know if you'd like changes before sending.*
