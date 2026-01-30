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


def main():
    parser = argparse.ArgumentParser(
        description="Export DSPy-optimized prompts to TypeScript"
    )
    parser.add_argument(
        "--input", "-i",
        type=str,
        help="Path to optimized agent JSON file"
    )
    parser.add_argument(
        "--output", "-o",
        type=str,
        help="Output file path (default: stdout)"
    )
    parser.add_argument(
        "--format", "-f",
        choices=["ts", "md", "persona"],
        default="ts",
        help="Output format: ts (TypeScript), md (Markdown), persona (update persona-prompts.ts)"
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
    
    args = parser.parse_args()
    
    # Load the optimized agent
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