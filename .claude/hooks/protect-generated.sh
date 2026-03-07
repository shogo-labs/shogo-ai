#!/bin/bash
# Hook script to prevent modification of auto-generated files
# Used as a PreToolUse hook for Edit, MultiEdit, and Write tools
#
# EXCEPTIONS:
#   - *.hooks.ts files are user-editable customization points
#   - Add additional patterns to EDITABLE_PATTERNS as needed

# Read the tool input from stdin
input=$(cat)

# Extract the file path from the tool input
# The input is JSON with structure: {"tool_name": "...", "tool_input": {"file_path": "...", ...}}
file_path=$(echo "$input" | jq -r '.tool_input.file_path // .tool_input.filePath // .tool_input.path // empty')

# If no file path found, allow the operation
if [ -z "$file_path" ]; then
  exit 0
fi

# Check if the file is in a generated directory
if [[ "$file_path" == */generated/* ]] || [[ "$file_path" == *"/generated/"* ]]; then
  
  # EXCEPTION: Allow *.hooks.ts files - these are user-editable customization points
  if [[ "$file_path" == *.hooks.ts ]]; then
    exit 0
  fi

  # EXCEPTION: Allow domain-actions.ts - manually maintained orchestration logic
  if [[ "$file_path" == */domain-actions.ts ]]; then
    exit 0
  fi

  # Add more exceptions here as needed:
  # if [[ "$file_path" == *.custom.ts ]]; then
  #   exit 0
  # fi

  # Output JSON to block the operation with helpful regeneration instructions
  cat << 'EOF'
{
  "decision": "block",
  "reason": "PROTECTED FILE: Cannot modify auto-generated files in /generated/ directories.\n\nEXCEPTION: Files matching *.hooks.ts ARE editable - these are customization points for business logic.\n\nTO REGENERATE:\n  • API routes & hooks scaffolds: bun run generate:routes\n  • Prisma client: bun run db:generate\n\nIf you need to customize behavior, look for or create a corresponding *.hooks.ts file instead of modifying the generated code directly."
}
EOF
  exit 0
fi

# Allow the operation (no output or empty JSON means proceed)
exit 0

