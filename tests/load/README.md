# Shogo AI Load Testing

Comprehensive load testing suite for Shogo AI staging infrastructure.

## Quick Start

```bash
# 1. Setup
cd tests/load
bash scripts/setup.sh
source .venv/bin/activate

# 2. Configure
cp .env.example .env
# Edit .env with your staging credentials

# 3. Run simple tests (25 minutes)
bash scripts/run_simple.sh

# 4. Run complex tests (85 minutes)
bash scripts/run_complex.sh

# 5. View reports
open reports/auth_test_report.html
```

## Test Scenarios

### Simple Tests (Phase 1)
- **auth_test.py** - Authentication load (100 users, 5 min)
- **workspace_test.py** - Workspace CRUD (200 users, 10 min)
- **mcp_test.py** - MCP operations (100 users, 10 min)

### Complex Tests (Phase 2)
- **multi_tenant_test.py** - Multi-tenant simulation (150 users, 30 min)
- **cold_start_test.py** - Knative cold start stress (100 users, 15 min)
- **chat_heavy_test.py** - Chat-heavy workload (100 users, 20 min)
- **data_intensive_test.py** - Data operations (50 users, 20 min)
- **agent_runtime_test.py** - Agent runtime endpoints (5-20 users, 5-30 min)

## Directory Structure

```
tests/load/
├── locustfiles/        # Test definitions
│   ├── common/         # Shared utilities
│   ├── simple/         # Phase 1 tests
│   └── complex/        # Phase 2 tests
├── scenarios/          # Reusable scenarios
├── users/              # Custom user behaviors
├── fixtures/           # Test data
├── scripts/            # Automation scripts
└── reports/            # Generated reports
```

## Key Scripts

- `scripts/setup.sh` - Install dependencies and setup environment
- `scripts/setup_test_data.py` - Pre-populate test data
- `scripts/run_simple.sh` - Run simple test suite
- `scripts/run_complex.sh` - Run complex test suite
- `scripts/run_agent_runtime.sh` - Run agent runtime load test
- `scripts/run_all.sh` - Run full test suite
- `scripts/analyze_results.py` - Analyze results
- `scripts/cleanup.py` - Clean up test data

### Agent Runtime Quick Start

```bash
# Default (5 users, 5 min) — includes chat/LLM calls
bash scripts/run_agent_runtime.sh

# No LLM calls — only exercises non-AI endpoints (free)
bash scripts/run_agent_runtime.sh --no-chat

# Stress test (20 users, 10 min)
bash scripts/run_agent_runtime.sh --stress

# Soak test (3 users, 30 min)
bash scripts/run_agent_runtime.sh --soak

# Only specific endpoint groups
bash scripts/run_agent_runtime.sh --tags health,files,dynamic-app

# Custom
bash scripts/run_agent_runtime.sh --users 10 --time 15m --host https://studio-staging.shogo.ai
```

## Monitoring

During tests, monitor:
- Grafana: `$GRAFANA_URL`
- Prometheus: `$PROMETHEUS_URL`
- Kubernetes pods: `kubectl get pods -n shogo-staging-system`

## Results

Reports are generated in `reports/` directory:
- HTML reports with charts
- CSV data for further analysis
- Summary statistics

## Success Criteria

**Simple Tests:**
- ✅ Error rate < 1%
- ✅ P95 latency < 2s
- ✅ P99 latency < 5s

**Complex Tests:**
- ✅ Error rate < 1%
- ✅ P95 latency < 3s
- ✅ No resource exhaustion
- ✅ Knative scales properly

## Troubleshooting

**Connection errors:**
- Verify staging URL in `.env`
- Check VPN/network access
- Validate credentials

**High error rate:**
- Check API logs: `kubectl logs -f deployment/api -n shogo-staging-system`
- Verify database health
- Check rate limiting

**Slow performance:**
- Monitor resource usage
- Check database connection pool
- Review Knative autoscaling

## Documentation

See `LOAD_TESTING_PLAN.md` for comprehensive documentation.
