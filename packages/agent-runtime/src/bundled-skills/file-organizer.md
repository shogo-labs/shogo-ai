---
name: file-organizer
version: 1.0.0
description: Organize, categorize, and clean up workspace files
trigger: "organize files|clean up|sort files|tidy up|file management"
tools: [read_file, write_file, exec]
---

# File Organizer

When the user asks to organize or clean up files:

1. **Survey:** List current workspace files with `exec("ls -la")`
2. **Analyze:** Identify file types, sizes, and potential organization
3. **Propose:** Suggest an organization plan before making changes
4. **Execute:** Only reorganize after user confirms

## Guidelines

- Never delete files without explicit confirmation
- Create logical directory structures (e.g., docs/, data/, scripts/)
- Move related files together
- Create a README.md summarizing the organization if one doesn't exist
- Report what was moved and why
