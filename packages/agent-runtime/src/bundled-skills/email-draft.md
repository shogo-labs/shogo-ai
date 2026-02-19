---
name: email-draft
version: 1.0.0
description: Draft professional emails based on context and intent
trigger: "draft email|write email|compose email|email template"
tools: [write_file, memory_read]
---

# Email Draft

When the user asks to draft an email:

1. **Gather context:** Who is it to? What's the purpose? What tone?
2. **Check memory** for any relevant context about the recipient
3. **Draft** the email with proper structure
4. **Save** to a file for the user to review and send

## Email Structure

- **Subject line:** Clear, concise, actionable
- **Opening:** Appropriate greeting for the relationship
- **Body:** Clear purpose in the first paragraph, supporting details after
- **Closing:** Clear call-to-action or next steps
- **Sign-off:** Appropriate for the tone

## Tone Guidelines

- **Professional:** Formal language, full sentences, respectful
- **Casual:** Friendly, conversational, still clear
- **Urgent:** Direct, action-oriented, clear deadline

Save the draft to `drafts/email-[topic]-[date].md` in the workspace.
