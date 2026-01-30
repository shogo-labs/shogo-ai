# Prompt Optimization Guide

This guide explains how to use the evaluation framework to systematically improve the Shogo agent's prompts.

## Overview

The evaluation framework provides:
- **27+ test cases** covering template selection, tool usage, multi-turn, and edge cases
- **Automated scoring** based on tool correctness, parameter accuracy, and response quality
- **Metrics tracking** to measure improvement over time
- **Comparison reports** to see what changed

## Quick Start

```bash
# 1. Start the agent API (in one terminal)
bun run api:dev

# 2. Check agent is responding
bun run packages/mcp/src/evals/cli.ts health

# 3. Establish baseline before making changes
bun run packages/mcp/src/evals/cli.ts baseline

# 4. Run evals to see current performance
bun run packages/mcp/src/evals/cli.ts --verbose
```

## Optimization Workflow

### Step 1: Understand Current Performance

```bash
# Run full eval suite with extended tests
bun run packages/mcp/src/evals/cli.ts --extended --verbose

# Or run specific category
bun run packages/mcp/src/evals/cli.ts --category template-selection --verbose
```

Look at the report for:
- **Pass rate** - Overall success percentage
- **Failed evals** - Which specific tests failed
- **Anti-patterns** - What the agent shouldn't have done
- **Metrics** - Template selection accuracy, tool call success, etc.

### Step 2: Identify Issues

Common issues and their symptoms:

| Symptom | Likely Issue | Fix Location |
|---------|--------------|--------------|
| Wrong template selected | Keyword mapping unclear | Template Selection Matrix in prompt |
| Asks too many questions | Confidence thresholds too low | Guidelines section |
| Runs manual commands | Unclear that template.copy handles everything | Tool description |
| Doesn't offer customization | Missing in response guidelines | Expected response section |

### Step 3: Make Targeted Changes

Edit the prompts at `apps/api/src/prompts/persona-prompts.ts`:

```typescript
// The SHOGO_AGENT_PROMPT is the main prompt for the Shogo agent
const SHOGO_AGENT_PROMPT = `...`
```

**Tips for prompt changes:**
- Make ONE change at a time
- Be specific and explicit
- Use examples when possible
- Test after each change

### Step 4: Measure Impact

```bash
# Run evals with a label and save results
bun run packages/mcp/src/evals/cli.ts --label "added-examples" --save --extended

# This automatically compares to baseline
```

Review the comparison report:
- ✅ **Improved** - Metrics that got better
- ❌ **Regressed** - Metrics that got worse
- ➖ **Unchanged** - No significant change

### Step 5: Iterate

If metrics improved → keep the change, move to next issue
If metrics regressed → revert and try different approach
If unchanged → change might not address root cause

## Key Metrics

| Metric | Target | What It Measures |
|--------|--------|------------------|
| Template Selection Accuracy | >90% | Picks correct template |
| Tool Call Success Rate | >95% | Tools called correctly |
| Parameter Accuracy | >95% | Params are right |
| First-Try Success | >80% | Completes without retry |
| Clarification Rate | <20% | Doesn't over-ask |

## Example Prompt Improvements

### Problem: Agent selects wrong template

**Before:**
```
Templates match based on keywords
```

**After:**
```
**Template Selection Matrix:**
| Keywords | Template | Confidence |
|----------|----------|------------|
| "todo", "task", "checklist" | todo-app | High |
| "expense", "budget", "spending" | expense-tracker | High |
...

When confidence is HIGH, proceed directly.
When confidence is MEDIUM, proceed but mention alternative.
When confidence is LOW, ask ONE clarifying question.
```

### Problem: Agent asks unnecessary questions

**Before:**
```
Ask the user what they need.
```

**After:**
```
Guidelines:
1. If the request clearly matches a template (High confidence), proceed without asking.
2. Only ask ONE clarifying question when the request is genuinely ambiguous.
3. Never ask multiple questions or ask about details that don't affect template choice.
```

### Problem: Agent runs manual commands

**Before:**
```
Use template.copy to set up the project.
```

**After:**
```
**IMPORTANT:** template.copy handles EVERYTHING automatically:
1. Copies files
2. Runs bun install
3. Runs prisma generate
4. Runs prisma db push
5. Builds the project
6. Starts the preview server

Do NOT run these commands manually after template.copy.
```

## Running in CI

Add to your CI pipeline:

```yaml
- name: Run Agent Evals
  run: |
    bun run packages/mcp/src/evals/cli.ts --json > eval-results.json
    
- name: Check Pass Rate
  run: |
    PASS_RATE=$(jq '.summary.passRate' eval-results.json)
    if (( $(echo "$PASS_RATE < 70" | bc -l) )); then
      echo "Eval pass rate too low: $PASS_RATE%"
      exit 1
    fi
```

## Adding New Test Cases

If you find a bug or edge case not covered:

1. Add to markdown evals in `.claude/skills/shogo-agent/evals/`
2. Add programmatic test in `packages/mcp/src/evals/test-cases-extended.ts`
3. Run tests to verify
4. Use to guide prompt improvements

## Files Reference

| File | Purpose |
|------|---------|
| `apps/api/src/prompts/persona-prompts.ts` | The actual prompts to optimize |
| `.claude/skills/shogo-agent/SKILL.md` | Expected agent behavior spec |
| `.claude/skills/shogo-agent/evals/` | Markdown eval test cases |
| `packages/mcp/src/evals/` | Automated evaluation framework |
| `.shogo-evals/metrics-history.json` | Saved metrics over time |
