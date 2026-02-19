---
name: meeting-notes
version: 1.0.0
description: Capture and organize meeting notes with action items
trigger: "meeting notes|summarize meeting|meeting summary|action items from meeting"
tools: [write_file, memory_write]
---

# Meeting Notes

When the user provides meeting content to summarize:

1. **Parse** the meeting content (transcript, notes, or description)
2. **Extract** key components:
   - Attendees
   - Decisions made
   - Action items with owners and deadlines
   - Open questions
   - Key discussion points
3. **Save** structured notes to a file
4. **Log** action items to memory for follow-up

## Output Format

### Meeting Notes — [Topic] — [Date]

**Attendees:** Person A, Person B, Person C

**Summary:** 2-3 sentence overview of the meeting

**Decisions:**
- [Decision 1]
- [Decision 2]

**Action Items:**
- [ ] [Task] — @owner — due [date]
- [ ] [Task] — @owner — due [date]

**Open Questions:**
- [Question that needs follow-up]

Save to `notes/meeting-[topic]-[date].md`.
