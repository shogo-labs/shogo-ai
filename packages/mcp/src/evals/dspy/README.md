# DSPy Prompt Optimization for Shogo Agent

This module uses [DSPy](https://github.com/stanfordnlp/dspy) to automatically optimize the Shogo agent's prompts for better template selection accuracy.

## What is DSPy?

DSPy is a framework for algorithmically optimizing LLM prompts and weights. Instead of manually tweaking prompts, DSPy:
1. Defines the desired behavior as a "signature"
2. Uses optimization algorithms (MIPRO, BootstrapFewShot) to find better prompts
3. Evaluates against metrics you define
4. Exports optimized prompts for use in production

## Setup

```bash
# Install Python dependencies
cd packages/mcp/src/evals/dspy
pip install -r requirements.txt

# Set your Anthropic API key
export ANTHROPIC_API_KEY=your-key-here
```

## Usage

### 1. Run Optimization

```bash
# Basic MIPRO optimization (recommended)
python -m packages.mcp.src.evals.dspy.optimize --strategy mipro --num-trials 25

# Bootstrap few-shot optimization (faster, adds examples)
python -m packages.mcp.src.evals.dspy.optimize --strategy bootstrap

# Combined approach (most thorough)
python -m packages.mcp.src.evals.dspy.optimize --strategy combined --num-trials 25

# Just evaluate current performance (no optimization)
python -m packages.mcp.src.evals.dspy.optimize --eval-only
```

### 2. Export Optimized Prompts

```bash
# Export as TypeScript
python -m packages.mcp.src.evals.dspy.export \
  --input results/optimized_agent_mipro.json \
  --output optimized-prompt.ts

# Export as Markdown documentation
python -m packages.mcp.src.evals.dspy.export \
  --input results/optimized_agent_mipro.json \
  --format md

# Directly update persona-prompts.ts (use with caution)
python -m packages.mcp.src.evals.dspy.export \
  --input results/optimized_agent_mipro.json \
  --format persona \
  --dry-run  # Preview first!
```

### 3. Verify Improvement

```bash
# Run TypeScript evals to verify
bun run packages/mcp/src/evals/cli.ts --verbose
```

## Files

| File | Purpose |
|------|---------|
| `signatures.py` | DSPy signatures defining agent input/output contract |
| `dataset.py` | Training and test examples |
| `metrics.py` | Evaluation metrics (accuracy, clarification, combined) |
| `optimize.py` | Main optimization script |
| `export.py` | Export optimized prompts to TypeScript |

## How It Works

### 1. Signatures (`signatures.py`)

Defines what the agent should do:

```python
class TemplateSelection(dspy.Signature):
    """Select the most appropriate starter template."""
    
    user_request: str = dspy.InputField()
    selected_template: str = dspy.OutputField()
    reasoning: str = dspy.OutputField()
```

### 2. Dataset (`dataset.py`)

Training examples for optimization:

```python
DIRECT_MATCH_EXAMPLES = [
    ("Build a todo app", "todo-app", "Direct keyword match"),
    ("Track my spending", "expense-tracker", "Semantic match"),
    ...
]
```

### 3. Metrics (`metrics.py`)

How we measure success:

- **template_accuracy**: Did it pick the right template?
- **no_unnecessary_clarification**: Did it avoid asking when it shouldn't?
- **combined_metric**: Weighted combination (50% accuracy, 30% no-clarify, 20% reasoning)

### 4. Optimization (`optimize.py`)

MIPRO algorithm:
1. Starts with base prompt
2. Generates candidate variations
3. Evaluates each against training set
4. Keeps best performing instructions
5. Iterates to find optimal prompt

## Optimization Strategies

| Strategy | Speed | Best For |
|----------|-------|----------|
| `mipro` | Slow (25 trials) | Instruction optimization |
| `bootstrap` | Fast | Adding few-shot examples |
| `combined` | Slowest | Best overall results |

## Example Results

Before optimization:
```
Template Selection Accuracy: 78%
Combined Score: 0.72
```

After MIPRO optimization:
```
Template Selection Accuracy: 94%
Combined Score: 0.89
Improvement: +16% accuracy
```

## Troubleshooting

### "No module named dspy"
```bash
pip install dspy-ai
```

### "ANTHROPIC_API_KEY not set"
```bash
export ANTHROPIC_API_KEY=your-key-here
```

### Optimization is slow
- Reduce `--num-trials` to 10-15
- Use `--strategy bootstrap` for faster (but less thorough) optimization
- Use `--use-full-agent` only when needed

## Integration with TypeScript Evals

The DSPy optimization complements the TypeScript eval framework:

1. **TypeScript evals** (`packages/mcp/src/evals/`): Test against live agent
2. **DSPy optimization**: Improve prompts algorithmically
3. **Export**: Convert DSPy improvements to TypeScript

Workflow:
```
[Run TS evals] → [Identify issues] → [Run DSPy] → [Export] → [Run TS evals again]
```
