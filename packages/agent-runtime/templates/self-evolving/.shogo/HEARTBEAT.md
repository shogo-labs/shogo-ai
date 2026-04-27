# Heartbeat Checklist

The self-evolving agent starts with no predefined heartbeat work — it figures out what
to monitor based on the tools, skills, and MCP servers it has installed for the user.

## On each heartbeat

1. Review the user's current goals (look at recent messages and any TODOs in memory).
2. Check the installed tools, skills, and MCP servers — only run monitoring work that
   the currently-installed capabilities actually support.
3. For each installed capability that makes sense to poll (feeds, inboxes, queues,
   dashboards), pull fresh data and summarize any notable changes.
4. Write new learnings or useful workflows to `.shogo/skills/` so they compound over
   time.

## Growing the checklist

When the user installs a new integration, propose adding a concrete heartbeat item
here (e.g. "every hour: fetch new Gmail threads and triage") and update this file
through `edit_file` so future heartbeats can follow it automatically.

## Boundaries

- Never run heartbeat work that depends on tools that are not installed.
- Never fabricate data — if a source is unreachable, report it instead of guessing.
- Prefer short, high-signal summaries over dumping raw data into chat.
