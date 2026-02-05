# Build Recovery Evaluation Guide

Quick reference for using the DSPy build recovery evaluation framework.

## Prerequisites

```bash
export ANTHROPIC_API_KEY=your_key_here
cd /Users/russell/git/shogo-ai/packages/mcp/src/evals/dspy
```

## Common Commands

### 1. Run Evaluation Only (No Optimization)

Test a model's current build recovery performance:

```bash
# Test with Haiku (fastest, cheapest)
python optimize_build_recovery.py --eval-only --model claude-3-5-haiku-20241022

# Test with Sonnet 4 (best performance)
python optimize_build_recovery.py --eval-only --model claude-sonnet-4-20250514
```

**Output:** Detailed metrics showing how well the model handles build failures.

### 2. Compare All Models

Run all available models and compare results:

```bash
python optimize_build_recovery.py --compare-models
```

**Output:** Side-by-side comparison table with scores for each model.

### 3. Test Single Scenario in Detail

Debug a specific build failure scenario:

```bash
# Available scenarios:
# - missing_routes_directory
# - nitro_bundle_size_error
# - prisma_client_not_generated
# - typescript_syntax_error
# - dependency_missing
# - multiple_errors_cascade
# - unfixable_pod_oom

python optimize_build_recovery.py --test-scenario missing_routes_directory --model claude-3-5-haiku-20241022
```

**Output:** Detailed breakdown of agent's response with step-by-step evaluation.

### 4. Run Optimization (MIPRO)

Algorithmically optimize the prompt for better performance:

```bash
python optimize_build_recovery.py --strategy mipro --model claude-sonnet-4-20250514 --num-trials 25
```

**Output:** Optimized agent with improved prompt instructions.

## Understanding the Metrics

| Metric | What It Measures | Weight |
|--------|------------------|--------|
| **Reads Logs** | Does the agent read `.build.log`? | 25% |
| **Categorization** | Correct error type identification | 20% |
| **Self-Fix Detection** | Knows if can self-recover | 15% |
| **Plan Quality** | Quality of recovery plan | 25% |
| **Action Correctness** | Correct specific commands/files | 15% |

**Combined Score** = Weighted average of all metrics.

**Passing Threshold:** ≥ 0.7 (70%)

## Interpreting Results

### Good Results (≥ 70%)
- Agent reads logs consistently
- Correctly categorizes errors
- Has concrete, actionable plans
- Identifies correct files/commands

### Poor Results (< 40%)
- Skips log reading
- Misidentifies error types
- Generic or incomplete plans
- Wrong or missing actions

### Critical Success Factors
1. ✅ **Will Read Logs** - Most important!
2. ✅ **Identifies Root Cause** - Shows understanding
3. ✅ **Has Concrete Plan** - Not vague
4. ✅ **Creates Files** - Specific file names
5. ✅ **No False Reassurance** - Honest about limitations

## Dataset Overview

### Training Set (17 scenarios)
- Missing files (routes, directories)
- TypeScript errors (syntax, imports, types)
- Build system errors (Nitro, Vite)
- Dependency issues
- Schema sync problems
- Multiple cascading errors
- Unfixable infrastructure issues

### Test Set (5 scenarios)
- Routes empty (not missing)
- Wrong file extension
- Wrong import path depth
- Missing React import
- Stale generated files

## Typical Workflow

### 1. Baseline Evaluation
```bash
python optimize_build_recovery.py --eval-only --model claude-3-5-haiku-20241022
```
**Goal:** Understand current performance before making changes.

### 2. Make Changes to System Prompt
Edit `/Users/russell/git/shogo-ai/packages/project-runtime/src/system-prompt.ts`

### 3. Re-Evaluate
```bash
python optimize_build_recovery.py --eval-only --model claude-3-5-haiku-20241022
```
**Goal:** Measure improvement from your changes.

### 4. Compare Models
```bash
python optimize_build_recovery.py --compare-models
```
**Goal:** Decide which model to use in production.

### 5. Optimize (Optional)
```bash
python optimize_build_recovery.py --strategy mipro --model claude-sonnet-4-20250514
```
**Goal:** Let DSPy algorithmically improve the prompt.

## Output Files

Results are saved to `packages/mcp/src/evals/dspy/results/`:

- `build_recovery_eval_MODEL_TIMESTAMP.json` - Single eval results
- `model_comparison_build_recovery_TIMESTAMP.json` - Multi-model comparison
- `build_recovery_mipro_MODEL_TIMESTAMP.json` - Optimization results

## Expected Runtime

| Command | Scenarios | Est. Time |
|---------|-----------|-----------|
| Eval only (Haiku) | 5 | ~20-30s |
| Eval only (Sonnet 4) | 5 | ~30-40s |
| Compare models | 15 | ~2-3min |
| Test single scenario | 1 | ~5-10s |
| MIPRO optimization | 17 train + 5 test | ~10-15min |

## Common Issues

### "ANTHROPIC_API_KEY not set"
```bash
export ANTHROPIC_API_KEY=$(grep ANTHROPIC_API_KEY /path/to/.env.local | cut -d= -f2)
```

### "Module not found"
Make sure you're in the correct directory:
```bash
cd /Users/russell/git/shogo-ai/packages/mcp/src/evals/dspy
```

### "Model not found" error
Some older model names may not be available. Use:
- `claude-3-5-haiku-20241022` (current Haiku)
- `claude-sonnet-4-20250514` (current Sonnet 4)

## Advanced Usage

### Custom Metric Weights

Edit `build_recovery_metrics.py` and modify the `combined_recovery_metric` function:

```python
def combined_recovery_metric(example, prediction, trace=None) -> float:
    # Adjust these weights
    return (
        reads * 0.25 +           # Log reading (default 25%)
        category * 0.20 +        # Categorization (default 20%)
        self_fix * 0.15 +        # Self-fix (default 15%)
        plan * 0.25 +            # Plan quality (default 25%)
        actions * 0.15           # Actions (default 15%)
    )
```

### Add New Scenarios

Edit `build_recovery_dataset.py` and add to `BUILD_FAILURE_SCENARIOS`:

```python
BUILD_FAILURE_SCENARIOS = [
    # ... existing scenarios ...
    (
        "your_scenario_name",
        "Error message shown to agent",
        "Build log excerpt (20-50 lines)",
        ["expected", "actions", "list"],
        "What the agent should do and why"
    ),
]
```

### Create Custom Metrics

Edit `build_recovery_metrics.py`:

```python
def my_custom_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    # Return 0.0 to 1.0
    if some_condition(prediction):
        return 1.0
    return 0.0
```

## Further Reading

- **Main Report:** `/Users/russell/git/shogo-ai/BUILD_RECOVERY_EVAL_HAIKU_FEB_5_2026.md`
- **Solution Plan:** `/Users/russell/git/shogo-ai/AGENT_BUILD_RECOVERY_SOLUTION.md`
- **DSPy Docs:** `packages/mcp/src/evals/dspy/README.md`
- **E2E QA Report:** `/Users/russell/git/shogo-ai/E2E_QA_REPORT_STAGING_FEB_5_2026.md`
