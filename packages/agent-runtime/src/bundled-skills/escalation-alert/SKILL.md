---
name: escalation-alert
version: 2.0.0
description: Escalate urgent issues to the team via connected channels
trigger: "escalate|urgent|p0|p1|critical issue|alert team|notify team"
tools: [send_message, memory_read, write_file]
---

# Escalation Alert

When a critical issue needs escalation:

1. **Assess severity** — Determine if this is genuinely P0/P1:
   - P0: service outage, data loss, security breach
   - P1: major feature broken, many users affected
2. **Compose alert** — Format a clear incident message:
   ```
   🔴 **[P0/P1] — [Brief Title]**
   **Impact:** [What's affected, how many users]
   **Started:** [When it began]
   **Status:** Investigating
   **Details:** [1-2 sentence description]
   ```
3. **Send** — Post via `send_message` to the configured alert channel
4. **Log** — Record the escalation in memory with timestamp
5. **Follow up** — On next heartbeat, check if the issue is resolved and post an update

Only escalate genuinely critical issues. For P2/P3, batch into daily digest instead.
