---
name: session-memory
description: Saves session context to memory when /new is issued
events: [command:new]
emoji: 💾
---

# Session Memory

When the user issues `/new`, this hook saves the recent conversation history
to a dated memory file in the workspace's `memory/` directory.
