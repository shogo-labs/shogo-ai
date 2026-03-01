"""
Export optimized DSPy prompts back into TypeScript source files.

Usage:
    python export.py --track canvas --target packages/agent-runtime/src/gateway.ts
    python export.py --track memory --target packages/agent-runtime/src/gateway-tools.ts
    python export.py --track personality --target packages/agent-runtime/src/system-prompt.ts
    python export.py --track skill --target packages/agent-runtime/src/skills.ts
    python export.py --track multiturn --target packages/agent-runtime/src/gateway.ts
"""

import argparse
import json
import re
from pathlib import Path


def load_optimized_program(track_name: str, results_dir: str = "results") -> dict:
    """Load the optimized program JSON for a track."""
    path = Path(results_dir) / f"{track_name}_optimized.json"
    if not path.exists():
        raise FileNotFoundError(f"No optimized program found at {path}. Run optimize.py first.")
    with open(path) as f:
        return json.load(f)


def extract_optimized_instructions(program_data: dict) -> str:
    """Extract the optimized instructions/prompt from a saved DSPy program."""
    # DSPy saves programs with different structures depending on the optimizer
    # Common patterns: program_data["predict"]["signature_instructions"]
    # or program_data["demos"] for few-shot examples

    instructions = ""

    if isinstance(program_data, dict):
        # Try to find instructions in various DSPy save formats
        for key in ["signature_instructions", "instructions", "extended_signature"]:
            if key in program_data:
                instructions = program_data[key]
                break

        # Recurse into nested structures
        if not instructions:
            for value in program_data.values():
                if isinstance(value, dict):
                    instructions = extract_optimized_instructions(value)
                    if instructions:
                        break

    return instructions


def extract_demos(program_data: dict) -> list[dict]:
    """Extract few-shot demos from a saved program."""
    demos = []

    if isinstance(program_data, dict):
        if "demos" in program_data:
            return program_data["demos"]
        for value in program_data.values():
            if isinstance(value, dict):
                demos = extract_demos(value)
                if demos:
                    break

    return demos


# ---------------------------------------------------------------------------
# Track-specific export logic
# ---------------------------------------------------------------------------

def export_canvas(target_path: str, program_data: dict):
    """Update CANVAS_TOOLS_GUIDE in gateway.ts with optimized instructions."""
    instructions = extract_optimized_instructions(program_data)
    demos = extract_demos(program_data)

    if not instructions and not demos:
        print("Warning: No optimized content found. Using program data as guide notes.")
        return

    target = Path(target_path)
    content = target.read_text()

    # Build optimized guide section
    guide_additions = []
    if instructions:
        guide_additions.append(f"\n// DSPy-optimized canvas planning instructions:\n// {instructions[:500]}")
    if demos:
        guide_additions.append(f"\n// Optimized with {len(demos)} few-shot examples")

    # Find the CANVAS_TOOLS_GUIDE constant and append optimization notes
    marker = "// [DSPy:canvas] Optimized instructions"
    if marker in content:
        # Replace existing optimization section
        pattern = re.compile(
            re.escape(marker) + r".*?// \[/DSPy:canvas\]",
            re.DOTALL,
        )
        replacement = marker + "\n" + "\n".join(guide_additions) + "\n// [/DSPy:canvas]"
        content = pattern.sub(replacement, content)
    else:
        print(f"  Note: Add '{marker}' ... '// [/DSPy:canvas]' markers in {target_path} to enable auto-replacement.")
        print(f"  Optimized instructions ({len(instructions)} chars) ready for manual insertion.")

    target.write_text(content)
    print(f"  Exported canvas optimizations to {target_path}")


def export_memory(target_path: str, program_data: dict):
    """Update memory tool descriptions in gateway-tools.ts."""
    instructions = extract_optimized_instructions(program_data)

    if not instructions:
        print("Warning: No optimized content found for memory track.")
        return

    target = Path(target_path)
    content = target.read_text()

    marker = "// [DSPy:memory] Optimized descriptions"
    if marker in content:
        pattern = re.compile(
            re.escape(marker) + r".*?// \[/DSPy:memory\]",
            re.DOTALL,
        )
        replacement = marker + f"\n// {instructions[:500]}\n// [/DSPy:memory]"
        content = pattern.sub(replacement, content)
        target.write_text(content)
        print(f"  Exported memory optimizations to {target_path}")
    else:
        print(f"  Note: Add '{marker}' ... '// [/DSPy:memory]' markers in {target_path}.")
        print(f"  Optimized instructions ({len(instructions)} chars) ready for manual insertion.")


def export_personality(target_path: str, program_data: dict):
    """Update TEMPLATE_SELECTION_GUIDE and DECISION_RULES in system-prompt.ts."""
    instructions = extract_optimized_instructions(program_data)
    demos = extract_demos(program_data)

    target = Path(target_path)
    content = target.read_text()

    marker = "// [DSPy:personality] Optimized template selection"
    if marker in content:
        additions = []
        if instructions:
            additions.append(f"// {instructions[:500]}")
        if demos:
            additions.append(f"// Optimized with {len(demos)} few-shot examples for template matching")
        pattern = re.compile(
            re.escape(marker) + r".*?// \[/DSPy:personality\]",
            re.DOTALL,
        )
        replacement = marker + "\n" + "\n".join(additions) + "\n// [/DSPy:personality]"
        content = pattern.sub(replacement, content)
        target.write_text(content)
        print(f"  Exported personality optimizations to {target_path}")
    else:
        print(f"  Note: Add '{marker}' ... '// [/DSPy:personality]' markers in {target_path}.")


def export_skill(target_path: str, program_data: dict):
    """Update matchSkill() logic in skills.ts with semantic matching."""
    instructions = extract_optimized_instructions(program_data)

    target = Path(target_path)
    content = target.read_text()

    marker = "// [DSPy:skill] Optimized matching logic"
    if marker in content:
        pattern = re.compile(
            re.escape(marker) + r".*?// \[/DSPy:skill\]",
            re.DOTALL,
        )
        replacement = marker + f"\n// {instructions[:500]}\n// [/DSPy:skill]"
        content = pattern.sub(replacement, content)
        target.write_text(content)
        print(f"  Exported skill optimizations to {target_path}")
    else:
        print(f"  Note: Add '{marker}' ... '// [/DSPy:skill]' markers in {target_path}.")


def export_multiturn(target_path: str, program_data: dict):
    """Update planning instructions in gateway.ts and session-manager.ts."""
    instructions = extract_optimized_instructions(program_data)

    target = Path(target_path)
    content = target.read_text()

    marker = "// [DSPy:multiturn] Optimized planning instructions"
    if marker in content:
        pattern = re.compile(
            re.escape(marker) + r".*?// \[/DSPy:multiturn\]",
            re.DOTALL,
        )
        replacement = marker + f"\n// {instructions[:500]}\n// [/DSPy:multiturn]"
        content = pattern.sub(replacement, content)
        target.write_text(content)
        print(f"  Exported multiturn optimizations to {target_path}")
    else:
        print(f"  Note: Add '{marker}' ... '// [/DSPy:multiturn]' markers in {target_path}.")


EXPORT_FNS = {
    "canvas": export_canvas,
    "memory": export_memory,
    "personality": export_personality,
    "skill": export_skill,
    "multiturn": export_multiturn,
}

DEFAULT_TARGETS = {
    "canvas": "packages/agent-runtime/src/gateway.ts",
    "memory": "packages/agent-runtime/src/gateway-tools.ts",
    "personality": "packages/agent-runtime/src/system-prompt.ts",
    "skill": "packages/agent-runtime/src/skills.ts",
    "multiturn": "packages/agent-runtime/src/gateway.ts",
}


def main():
    parser = argparse.ArgumentParser(description="Export DSPy optimizations to TypeScript")
    parser.add_argument("--track", required=True, choices=list(EXPORT_FNS.keys()) + ["all"],
                        help="Track to export")
    parser.add_argument("--target", help="Target TypeScript file (overrides default)")
    parser.add_argument("--results-dir", default="results", help="Directory with optimization results")
    args = parser.parse_args()

    tracks = list(EXPORT_FNS.keys()) if args.track == "all" else [args.track]

    for track in tracks:
        target = args.target or DEFAULT_TARGETS[track]
        print(f"\nExporting {track} -> {target}")

        try:
            program_data = load_optimized_program(track, args.results_dir)
            EXPORT_FNS[track](target, program_data)
        except FileNotFoundError as e:
            print(f"  Skipped: {e}")
        except Exception as e:
            print(f"  Error: {e}")

    print("\nExport complete.")


if __name__ == "__main__":
    main()
