# Shogo Agent Evaluations

This evaluation framework tests the Shogo AI agent's ability to understand user requests, select appropriate templates, and build working applications.

## Quick Start

```bash
cd packages/mcp/src/evals

# Run business user evals (default)
./run-evals.sh

# Run with specific options
./run-evals.sh --template crm --workers 4 --fresh
```

## Eval Categories

### Business User Evals (`--template business`)
32 test cases designed for non-technical users:

| Category | Tests | Description |
|----------|-------|-------------|
| **Vague Language** | 5 | Ambiguous requests like "keep track of everything" |
| **Confusion** | 4 | Filter vs field, computed vs stored, etc. |
| **Multi-turn** | 4 | Progressive refinement, undo, replace |
| **Relationship** | 4 | Many-to-many, self-referential, cascade delete |
| **Impossible** | 4 | Features we can't do (email, OCR, external sync) |
| **Error Recovery** | 3 | Handling crashes, missing data |
| **Conditional** | 3 | Required based on status, auto-update |
| **Migration** | 3 | Rename, make required, existing data |
| **Framework** | 3 | Unique constraints, soft delete, performance |

### Other Templates
- `--template crm` - CRM-specific test cases
- `--template inventory` - Inventory management test cases  
- `--template hard` - Advanced schema modification tests
- `--template all` - All test cases combined

## Running Evals

### Using the Script

```bash
# Basic usage (resumes from checkpoint if exists)
./run-evals.sh

# Fresh start
./run-evals.sh --fresh

# Different template
./run-evals.sh --template crm

# More workers (use cautiously - may cause crashes)
./run-evals.sh --workers 4

# Different model
./run-evals.sh --model haiku

# Enable verbose logging (logs to /tmp/eval-verbose-*.log)
./run-evals.sh --verbose

# Combine options
./run-evals.sh --fresh --verbose --workers 2
```

### Using the Server Directly

```bash
# Start the eval server
bun run src/evals/eval-server.ts --template business --model sonnet --workers 2 --port 7100

# Check status
curl http://localhost:7100/status

# Check checkpoint
curl http://localhost:7100/checkpoint

# Get results (when complete)
curl http://localhost:7100/results

# Stop run
curl -X POST http://localhost:7100/stop
```

## Checkpointing

The eval system automatically saves progress after each completed eval to `/tmp/eval-checkpoint.json`. If the process crashes:

1. Simply run the script again - it will resume from the checkpoint
2. Use `--fresh` to start over from the beginning
3. Checkpoint is automatically cleared when all evals complete

## Results

Results are saved to `/tmp/eval-results-{model}-{template}-{timestamp}.json` with:

```json
{
  "summary": {
    "total": 32,
    "passed": 15,
    "failed": 17,
    "avgScore": 46.25,
    "intentionPercent": 56.4,
    "executionPercent": 80.7
  },
  "tokens": {
    "input": 234567,
    "output": 45678,
    "total": 280245
  },
  "cost": {
    "total": 1.3894,
    "perEval": 0.0434,
    "inputCost": 0.7037,
    "outputCost": 0.6857
  },
  "results": [...]
}
```

### Cost Tracking

The eval system tracks token usage and cost for each eval. Pricing varies by model:

| Model | Input (per 1M) | Output (per 1M) |
|-------|----------------|-----------------|
| Sonnet | $3.00 | $15.00 |
| Haiku | $0.80 | $4.00 |
| Opus | $15.00 | $75.00 |

Cost is tracked:
- Per eval in results
- Running total in status endpoint
- Saved in checkpoints (so resumed runs track full cost)

Use `curl http://localhost:7100/status | jq '.cost'` to see running cost.

### Scoring Phases

Each eval criterion is tagged with a **phase**:

- **Intention** (🎯): Did the agent understand what to do?
  - Template selection, clarification requests, understanding context
  
- **Execution** (⚙️): Did the agent implement it correctly?
  - Code quality, schema correctness, build success

This separation helps identify whether failures are due to misunderstanding vs. implementation issues.

## Test Case Structure

```typescript
export const EVAL_EXAMPLE: AgentEval = {
  id: 'unique-id',
  name: 'Human-readable name',
  category: 'category-name',
  level: 5,  // 1-6 difficulty
  input: 'User message to the agent',
  expectedTemplate: 'crm' | 'todo' | 'inventory' | 'clarify',
  validationCriteria: [
    {
      id: 'criterion-id',
      description: 'What we check',
      points: 40,
      phase: 'intention' | 'execution',
      validate: (result) => result.toolCalls.some(t => ...),
    }
  ],
  maxScore: 100,
}
```

## Adding New Tests

1. Create test cases in the appropriate file:
   - `test-cases-business-user.ts` - Business user scenarios
   - `test-cases-crm.ts` - CRM-specific tests
   - `test-cases-hard.ts` - Advanced tests

2. Export from the file and add to the appropriate `ALL_*_EVALS` array

3. Add to `eval-server.ts` if creating a new category

## Verbose Logging

Enable verbose mode with `--verbose` or `-v` to capture detailed logs:

```bash
./run-evals.sh --verbose --fresh
```

Logs are saved to `/tmp/eval-verbose-{timestamp}.log` and include:
- Full input/output for each eval
- Tool calls and responses
- Criteria pass/fail details
- Error stack traces

The verbose log is always written to file; the flag also outputs to console.

## Known Issues

### Process Crashes
The eval process sometimes gets killed by the system after ~5-10 minutes. The checkpointing system handles this - just restart the script.

### Long-Running Evals
Some evals (especially multi-turn and error recovery) can take 10-30+ minutes each. Use fewer workers (2) for stability.

### HTTP Server Hangs
Sometimes the HTTP status endpoint hangs while workers are starting. The script handles this by monitoring the checkpoint file directly.

## Performance Tips

1. **Use 2 workers** - More stable than 4-6
2. **Monitor via checkpoint** - More reliable than HTTP when busy
3. **Run overnight** - Full suite takes 1-2 hours with 2 workers
4. **Check results file** - Summary is written even if console output fails

## File Structure

```
src/evals/
├── run-evals.sh           # Easy-to-use runner script
├── eval-server.ts         # HTTP server with checkpointing
├── runner.ts              # Core eval runner
├── types.ts               # TypeScript types
├── validators.ts          # Validation helper functions
├── test-cases.ts          # Basic test cases
├── test-cases-extended.ts # Extended test cases
├── test-cases-hard.ts     # Hard test cases
├── test-cases-crm.ts      # CRM-specific tests
├── test-cases-inventory.ts # Inventory tests
├── test-cases-business-user.ts # Business user tests
└── README.md              # This file
```
