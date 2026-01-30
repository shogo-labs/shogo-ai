#!/usr/bin/env python3
"""
Export Optimized Prompts to TypeScript

This module exports DSPy-optimized prompts back to the TypeScript codebase
so they can be used in the actual Shogo agent.

Usage:
    python -m packages.mcp.src.evals.dspy.export [options]

Options:
    --input FILE         Path to optimized agent JSON file
    --output FILE        Output TypeScript file (default: stdout)
    --format [ts|md]     Output format (default: ts)
    --dry-run            Preview without writing
"""

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional


def load_optimized_agent(agent_path: str) -> Dict[str, Any]:
    """Load an optimized agent from JSON file."""
    with open(agent_path, 'r') as f:
        return json.load(f)


def extract_instructions_from_agent(agent_data: Dict[str, Any]) -> Dict[str, str]:
    """Extract optimized instructions from agent data structure.
    
    DSPy saves agents with their optimized prompts/instructions.
    This function navigates the saved structure to extract them.
    DSPy 3.x uses a different format than earlier versions.
    """
    instructions = {}
    
    # DSPy 3.x format: keys like "select.predict" at top level
    for key, value in agent_data.items():
        if key == 'metadata':
            continue
        if isinstance(value, dict):
            # Check for signature instructions
            if 'signature' in value:
                sig = value['signature']
                if isinstance(sig, dict) and 'instructions' in sig:
                    instructions[key] = sig['instructions']
                elif isinstance(sig, str):
                    # Sometimes signature is stored as string
                    instructions[key] = sig
            # Check for demos
            if 'demos' in value and value['demos']:
                instructions[f'{key}_demos'] = value['demos']
            # Check for lm field with extended_signature
            if 'lm' in value and isinstance(value['lm'], dict):
                lm = value['lm']
                if 'extended_signature' in lm:
                    ext_sig = lm['extended_signature']
                    if isinstance(ext_sig, dict) and 'instructions' in ext_sig:
                        instructions[key] = ext_sig['instructions']
    
    # Older DSPy format: 'state' key
    if 'state' in agent_data:
        state = agent_data['state']
        for key, value in state.items():
            if isinstance(value, dict):
                if 'signature' in value:
                    sig = value['signature']
                    if isinstance(sig, dict) and 'instructions' in sig:
                        instructions[key] = sig['instructions']
                if 'demos' in value:
                    instructions[f'{key}_demos'] = value['demos']
    
    # Also check for direct instruction fields
    if 'instructions' in agent_data:
        instructions['main'] = agent_data['instructions']
    
    return instructions


def extract_demos_from_agent(agent_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Extract few-shot demonstrations from optimized agent."""
    demos = []
    
    # DSPy 3.x format: keys like "select.predict" at top level
    for key, value in agent_data.items():
        if key == 'metadata':
            continue
        if isinstance(value, dict) and 'demos' in value:
            for demo in value['demos']:
                # DSPy 3.x stores fields directly in demo
                if 'user_request' in demo:
                    demos.append({
                        'module': key,
                        'input': {'user_request': demo.get('user_request', '')},
                        'output': {
                            'selected_template': demo.get('selected_template', ''),
                            'reasoning': demo.get('reasoning', ''),
                        },
                    })
                else:
                    # Older format with inputs/outputs
                    demos.append({
                        'module': key,
                        'input': demo.get('inputs', {}),
                        'output': demo.get('outputs', {}),
                    })
    
    # Older DSPy format
    if 'state' in agent_data:
        state = agent_data['state']
        for key, value in state.items():
            if isinstance(value, dict) and 'demos' in value:
                for demo in value['demos']:
                    demos.append({
                        'module': key,
                        'input': demo.get('inputs', {}),
                        'output': demo.get('outputs', {}),
                    })
    
    return demos


def format_template_mapping_ts(instructions: Dict[str, str]) -> str:
    """Format template selection guidance as TypeScript."""
    
    template_guidance = instructions.get('select_template', instructions.get('select', ''))
    
    # Clean up the instruction text
    template_guidance = template_guidance.strip()
    
    # Escape backticks for template literal
    template_guidance = template_guidance.replace('`', '\\`')
    template_guidance = template_guidance.replace('${', '\\${')
    
    return template_guidance


def format_demos_as_examples(demos: List[Dict[str, Any]]) -> str:
    """Format few-shot demos as example text for the prompt."""
    if not demos:
        return ""
    
    lines = ["**Examples:**", ""]
    
    for i, demo in enumerate(demos[:5], 1):  # Limit to 5 examples
        input_data = demo.get('input', {})
        output_data = demo.get('output', {})
        
        request = input_data.get('user_request', '')
        template = output_data.get('selected_template', '')
        reasoning = output_data.get('reasoning', '')
        
        if request and template:
            lines.append(f'{i}. "{request}"')
            lines.append(f'   → **{template}** ({reasoning})')
            lines.append('')
    
    return '\n'.join(lines)


def generate_typescript_prompt(
    instructions: Dict[str, str],
    demos: List[Dict[str, Any]],
    include_header: bool = True
) -> str:
    """Generate TypeScript code for the optimized prompt."""
    
    timestamp = datetime.now().isoformat()
    
    # Build the prompt sections
    template_guidance = format_template_mapping_ts(instructions)
    examples = format_demos_as_examples(demos)
    
    header = f'''/**
 * DSPy-Optimized Shogo Agent Prompt
 * 
 * Generated: {timestamp}
 * 
 * This prompt was automatically generated by DSPy optimization.
 * To regenerate, run: python -m packages.mcp.src.evals.dspy.optimize
 */

''' if include_header else ''

    ts_code = f'''{header}/**
 * Optimized template selection instructions from DSPy.
 * These instructions were generated by MIPRO optimization to improve
 * template selection accuracy.
 */
export const OPTIMIZED_TEMPLATE_INSTRUCTIONS = `
{template_guidance}

{examples}
`.trim()

/**
 * Merge optimized instructions with base prompt.
 * Call this to get the enhanced SHOGO_AGENT_PROMPT.
 */
export function getOptimizedPrompt(basePrompt: string): string {{
  // Insert optimized instructions after the template selection section
  const insertPoint = basePrompt.indexOf('**Template Selection:**')
  
  if (insertPoint === -1) {{
    // If no insertion point found, append to end
    return basePrompt + '\\n\\n' + OPTIMIZED_TEMPLATE_INSTRUCTIONS
  }}
  
  // Find the end of the template selection section
  const sectionEnd = basePrompt.indexOf('##', insertPoint + 1)
  
  if (sectionEnd === -1) {{
    return basePrompt + '\\n\\n' + OPTIMIZED_TEMPLATE_INSTRUCTIONS
  }}
  
  // Insert the optimized instructions
  return (
    basePrompt.slice(0, sectionEnd) +
    '\\n\\n' + OPTIMIZED_TEMPLATE_INSTRUCTIONS + '\\n\\n' +
    basePrompt.slice(sectionEnd)
  )
}}

/**
 * Raw optimized instructions data for programmatic use.
 */
export const OPTIMIZED_INSTRUCTIONS = {json.dumps(instructions, indent=2)} as const

/**
 * Few-shot examples extracted from optimization.
 */
export const OPTIMIZED_DEMOS = {json.dumps(demos, indent=2)} as const
'''
    
    return ts_code


def generate_markdown_export(
    instructions: Dict[str, str],
    demos: List[Dict[str, Any]],
) -> str:
    """Generate Markdown documentation of optimized prompts."""
    
    timestamp = datetime.now().isoformat()
    
    template_guidance = instructions.get('select_template', instructions.get('select', 'No instructions found'))
    examples = format_demos_as_examples(demos)
    
    md = f'''# DSPy-Optimized Prompt

**Generated:** {timestamp}

## Optimized Template Selection Instructions

{template_guidance}

## Few-Shot Examples

{examples if examples else "No examples extracted."}

## Raw Instructions

```json
{json.dumps(instructions, indent=2)}
```

## How to Use

1. Copy the optimized instructions above
2. Update `apps/api/src/prompts/persona-prompts.ts`
3. Replace or augment the template selection section
4. Run evals to verify improvement: `bun run packages/mcp/src/evals/cli.ts`

## Regenerating

To regenerate optimized prompts:

```bash
# Run DSPy optimization
python -m packages.mcp.src.evals.dspy.optimize --strategy mipro --num-trials 25

# Export to TypeScript
python -m packages.mcp.src.evals.dspy.export --input results/optimized_agent_mipro.json
```
'''
    
    return md


def export_to_persona_prompts(
    instructions: Dict[str, str],
    demos: List[Dict[str, Any]],
    persona_file: Path,
    dry_run: bool = False
) -> str:
    """Directly update the persona-prompts.ts file with optimized instructions.
    
    This modifies the SHOGO_AGENT_PROMPT to include the optimized instructions.
    """
    if not persona_file.exists():
        raise FileNotFoundError(f"Persona file not found: {persona_file}")
    
    content = persona_file.read_text()
    
    # Find the SHOGO_AGENT_PROMPT
    prompt_start = content.find('const SHOGO_AGENT_PROMPT = `')
    if prompt_start == -1:
        raise ValueError("Could not find SHOGO_AGENT_PROMPT in file")
    
    # Build the optimized section
    template_guidance = instructions.get('select_template', instructions.get('select', ''))
    examples = format_demos_as_examples(demos)
    
    optimized_section = f'''

## DSPy-Optimized Template Selection

{template_guidance}

{examples}
'''
    
    # Find insertion point (before "## Guidelines" or end of prompt)
    guidelines_pos = content.find('## Guidelines', prompt_start)
    development_pos = content.find('## Development Tools', prompt_start)
    
    # Choose the earlier valid insertion point
    insertion_points = [p for p in [guidelines_pos, development_pos] if p > prompt_start]
    
    if insertion_points:
        insert_pos = min(insertion_points)
        # Insert before the found section
        new_content = (
            content[:insert_pos] +
            optimized_section +
            '\n' +
            content[insert_pos:]
        )
    else:
        # Find the end of the template literal
        prompt_end = content.find('`', content.find('`', prompt_start) + 1)
        if prompt_end == -1:
            raise ValueError("Could not find end of SHOGO_AGENT_PROMPT")
        
        # Insert before the closing backtick
        new_content = (
            content[:prompt_end] +
            optimized_section +
            content[prompt_end:]
        )
    
    if dry_run:
        print("=== DRY RUN - Would update file with: ===")
        print(optimized_section)
        return optimized_section
    
    # Write the updated content
    persona_file.write_text(new_content)
    print(f"Updated: {persona_file}")
    
    return optimized_section


def export_to_system_prompt(
    template_instructions: Dict[str, str],
    schema_instructions: Dict[str, str],
    prompt_file: Path,
    dry_run: bool = False
) -> str:
    """Update the system-prompt.ts file with DSPy-optimized prompts.
    
    This modifies the exported constants in the system-prompt.ts file:
    - TEMPLATE_SELECTION_GUIDE
    - SCHEMA_MODIFICATIONS
    
    Args:
        template_instructions: Instructions from optimized_agent_template_mipro.json
        schema_instructions: Instructions from optimized_schema_agent.json
        prompt_file: Path to packages/project-runtime/src/system-prompt.ts
        dry_run: If True, preview changes without writing
    
    Returns:
        Summary of changes made
    """
    if not prompt_file.exists():
        raise FileNotFoundError(f"System prompt file not found: {prompt_file}")
    
    content = prompt_file.read_text()
    changes = []
    
    # Extract template selection instructions
    template_prompt = template_instructions.get('select.predict', 
                      template_instructions.get('select', ''))
    
    if template_prompt:
        # Find the TEMPLATE_SELECTION_GUIDE constant
        marker = "export const TEMPLATE_SELECTION_GUIDE = `"
        template_start = content.find(marker)
        if template_start == -1:
            print("Warning: Could not find 'TEMPLATE_SELECTION_GUIDE' constant")
        else:
            # Find the closing backtick
            content_start = template_start + len(marker)
            template_end = content.find('`', content_start)
            
            if template_end != -1:
                # Build new template guide content
                # The DSPy-optimized prompt already includes the template list
                new_template_content = f'''## Template Selection Guide

{template_prompt}'''
                
                content = content[:content_start] + new_template_content + content[template_end:]
                changes.append("Updated TEMPLATE_SELECTION_GUIDE")
    
    # Extract schema modification instructions
    plan_prompt = schema_instructions.get('plan.predict', 
                  schema_instructions.get('plan', ''))
    generate_prompt = schema_instructions.get('generate.predict',
                      schema_instructions.get('generate', ''))
    
    if plan_prompt or generate_prompt:
        # Find the SCHEMA_MODIFICATIONS constant
        marker = "export const SCHEMA_MODIFICATIONS = `"
        schema_start = content.find(marker)
        if schema_start == -1:
            print("Warning: Could not find 'SCHEMA_MODIFICATIONS' constant")
        else:
            # Find the closing backtick (need to handle escaped backticks)
            content_start = schema_start + len(marker)
            # Find closing backtick that's not escaped
            pos = content_start
            while pos < len(content):
                next_backtick = content.find('`', pos)
                if next_backtick == -1:
                    break
                # Check if it's escaped
                if next_backtick > 0 and content[next_backtick-1] == '\\':
                    pos = next_backtick + 1
                    continue
                schema_end = next_backtick
                break
            
            if schema_end:
                # Build new schema section with DSPy-optimized prompts
                # Use raw string parts to avoid f-string backslash issues
                backtick = '\\`'
                triple_backtick = '\\`\\`\\`'
                
                # Use DSPy-optimized plan prompt or default
                plan_text = plan_prompt if plan_prompt else "You are an intelligent schema modification assistant. When users request to add or modify data fields, carefully analyze the request and determine precise database schema modifications."
                
                # Use DSPy-optimized generate prompt or default
                generate_text = generate_prompt if generate_prompt else f"""When generating Prisma field code:
- Use camelCase for field names
- Add {backtick}?{backtick} for optional fields
- Create full enum definitions when a custom enum type is specified
- Ensure type accuracy and schema compatibility"""
                
                new_schema_content = f"""## Schema Modifications (IMPORTANT)

{plan_text}

### Prisma Code Generation Rules

{generate_text}

### Workflow

1. **ALWAYS modify {backtick}prisma/schema.prisma{backtick}** - This is the source of truth for data models
2. **NEVER directly edit files in {backtick}src/generated/{backtick}** - These are auto-generated from the schema
3. **After schema changes, ALWAYS run**: {backtick}DATABASE_URL="file:./dev.db" bunx prisma generate && bunx prisma db push{backtick}
4. **Then update the UI** in {backtick}src/routes/{backtick} or {backtick}src/components/{backtick} to use the new fields

### Example: Adding a "priority" field to Todo

1. Edit {backtick}prisma/schema.prisma{backtick}:
   {triple_backtick}prisma
   enum Priority {{
     LOW
     MEDIUM
     HIGH
   }}
   
   model Todo {{
     ...
     priority Priority? @default(MEDIUM)
   }}
   {triple_backtick}

2. Run: {backtick}DATABASE_URL="file:./dev.db" bunx prisma generate && bunx prisma db push{backtick}

3. Update UI in {backtick}src/routes/index.tsx{backtick} to display/edit priority

### Files You Should NEVER Edit Directly

- {backtick}src/generated/prisma/*{backtick} - Auto-generated Prisma client
- {backtick}src/generated/types.ts{backtick} - Auto-generated TypeScript types
- {backtick}src/generated/*.ts{backtick} - All generated files

These files are regenerated from {backtick}prisma/schema.prisma{backtick}. Editing them directly will be overwritten."""
                
                content = content[:content_start] + new_schema_content + content[schema_end:]
                changes.append("Updated SCHEMA_MODIFICATIONS")
    
    if dry_run:
        print("=== DRY RUN - Would make these changes: ===")
        for change in changes:
            print(f"  - {change}")
        return "\n".join(changes)
    
    if changes:
        prompt_file.write_text(content)
        print(f"Updated: {prompt_file}")
        for change in changes:
            print(f"  - {change}")
    else:
        print("No changes made - could not find sections to update")
    
    return "\n".join(changes)


def main():
    parser = argparse.ArgumentParser(
        description="Export DSPy-optimized prompts to TypeScript"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        help="Path to optimized agent JSON file (for ts/md/persona formats)"
    )
    parser.add_argument(
        "--template-agent",
        type=str,
        help="Path to optimized template agent JSON (for server format)"
    )
    parser.add_argument(
        "--schema-agent",
        type=str,
        help="Path to optimized schema agent JSON (for server format)"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output file path (default: stdout)"
    )
    parser.add_argument(
        "--format", "-f",
        choices=["ts", "md", "persona", "server"],
        default="ts",
        help="Output format: ts (TypeScript), md (Markdown), persona (update persona-prompts.ts), server (update project-runtime server.ts)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview output without writing files"
    )
    parser.add_argument(
        "--persona-file",
        type=str,
        default="apps/api/src/prompts/persona-prompts.ts",
        help="Path to persona-prompts.ts for --format persona"
    )
    parser.add_argument(
        "--prompt-file",
        type=str,
        default="packages/project-runtime/src/system-prompt.ts",
        help="Path to system-prompt.ts for --format server"
    )
    parser.add_argument(
        "--results-dir",
        type=str,
        default="packages/mcp/src/evals/dspy/results",
        help="Directory containing DSPy results (for auto-discovery)"
    )
    
    args = parser.parse_args()
    
    # Handle server format (uses both template and schema agents)
    if args.format == "server":
        results_dir = Path(args.results_dir)
        
        # Auto-discover or use provided paths
        template_agent_path = args.template_agent or results_dir / "optimized_agent_template_mipro.json"
        schema_agent_path = args.schema_agent or results_dir / "optimized_schema_agent.json"
        
        template_instructions = {}
        schema_instructions = {}
        
        if Path(template_agent_path).exists():
            print(f"Loading template agent from: {template_agent_path}")
            template_data = load_optimized_agent(str(template_agent_path))
            template_instructions = extract_instructions_from_agent(template_data)
            print(f"  Extracted {len(template_instructions)} template instructions")
        else:
            print(f"Warning: Template agent not found at {template_agent_path}")
        
        if Path(schema_agent_path).exists():
            print(f"Loading schema agent from: {schema_agent_path}")
            schema_data = load_optimized_agent(str(schema_agent_path))
            schema_instructions = extract_instructions_from_agent(schema_data)
            print(f"  Extracted {len(schema_instructions)} schema instructions")
        else:
            print(f"Warning: Schema agent not found at {schema_agent_path}")
        
        if not template_instructions and not schema_instructions:
            print("Error: No optimized agents found. Run DSPy optimization first:")
            print("  python optimize.py --model claude-3-5-haiku-20241022 --output ./results")
            return
        
        prompt_path = Path(args.prompt_file)
        output = export_to_system_prompt(
            template_instructions, schema_instructions, prompt_path, args.dry_run
        )
        if not args.dry_run and output:
            print(f"\n✅ Successfully updated {prompt_path}")
        return
    
    # Load the optimized agent (for other formats)
    if args.input:
        print(f"Loading optimized agent from: {args.input}")
        agent_data = load_optimized_agent(args.input)
    else:
        # Use sample data for testing
        print("No input file specified, using sample data for demonstration")
        agent_data = {
            'state': {
                'select': {
                    'signature': {
                        'instructions': '''Select the template that best matches the user's request.

**Keyword Matching (High Confidence):**
- "todo", "task", "checklist" → todo-app
- "expense", "budget", "spending", "finance" → expense-tracker  
- "crm", "customer", "sales", "leads" → crm
- "inventory", "stock", "warehouse" → inventory
- "kanban", "board", "cards" → kanban
- "chat", "chatbot", "assistant" → ai-chat
- "form builder", "survey" → form-builder
- "feedback", "reviews" → feedback-form
- "booking", "appointment" → booking-app

**Decision Rules:**
1. Exact keyword match → proceed immediately (no questions)
2. Semantic match (e.g., "track spending" → expense) → proceed with brief explanation
3. Ambiguous (e.g., "business app") → ask ONE clarifying question with options
4. No match → explain limitation and offer alternatives'''
                    },
                    'demos': [
                        {
                            'inputs': {'user_request': 'Build a todo app'},
                            'outputs': {'selected_template': 'todo-app', 'reasoning': 'Direct keyword match: todo'}
                        },
                        {
                            'inputs': {'user_request': 'Track my spending'},
                            'outputs': {'selected_template': 'expense-tracker', 'reasoning': 'Semantic match: spending → expense tracking'}
                        },
                    ]
                }
            }
        }
    
    # Extract instructions and demos
    instructions = extract_instructions_from_agent(agent_data)
    demos = extract_demos_from_agent(agent_data)
    
    print(f"Extracted {len(instructions)} instruction sets")
    print(f"Extracted {len(demos)} few-shot demos")
    
    # Generate output based on format
    if args.format == "ts":
        output = generate_typescript_prompt(instructions, demos)
    elif args.format == "md":
        output = generate_markdown_export(instructions, demos)
    elif args.format == "persona":
        persona_path = Path(args.persona_file)
        output = export_to_persona_prompts(
            instructions, demos, persona_path, args.dry_run
        )
        if not args.dry_run:
            print(f"\n✅ Successfully updated {persona_path}")
        return
    
    # Output
    if args.output and not args.dry_run:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(output)
        print(f"\n✅ Exported to: {output_path}")
    else:
        if args.dry_run:
            print("\n=== DRY RUN OUTPUT ===\n")
        print(output)


if __name__ == "__main__":
    main()