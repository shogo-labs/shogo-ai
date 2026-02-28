---
name: meeting-prep
version: 1.0.0
description: Prepare for meetings with agenda, attendee context, and background research
trigger: "prep for meeting|meeting prep|prepare for|brief me on"
tools: [read_file, web, memory_search]
---

# Meeting Prep

When preparing for a meeting:

1. Check MEMORY.md for past interactions with attendees
2. Look up attendee information (contacts.md or web search)
3. Review any relevant documents or previous meeting notes
4. Compile a briefing

## Output Format

### Meeting Brief: [Meeting Title]
**Time:** [When]
**Attendees:** [Who]

**Attendee Context:**
- [Person] — [Role, last interaction, relevant notes]

**Agenda Suggestions:**
1. [Topic based on recent context]
2. [Open items from last meeting]

**Background:**
- [Relevant recent developments]
- [Key talking points]

**Questions to Ask:**
- [Suggested questions]
