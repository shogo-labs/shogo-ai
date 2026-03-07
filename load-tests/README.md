# Shogo AI Load Testing

Load testing suite for Shogo AI staging infrastructure, focused on agent runtimes.

## Quick Start

```bash
# 1. Setup
cd tests/load
bash scripts/setup.sh
source .venv/bin/activate

# 2. Configure
cp env.example .env
# Edit .env with your staging credentials

# 3. Run agent runtime test (recommended starting point)
bash scripts/run_agent_runtime.sh

# 4. Run simple tests (25 minutes)
bash scripts/run_simple.sh

# 5. Run complex tests (85 minutes)
bash scripts/run_complex.sh

# 6. View reports
open reports/agent_runtime_*.html
```

## Test Scenarios

### Agent Runtime Test (Primary)
- **agent_runtime_test.py** - Full agent runtime surface: create AGENT projects,
  send build-oriented chat messages, exercise health/status/files/catalog/dynamic-app
  endpoints via agent-proxy. Measures warm pool claim time and SLOs.

### Simple Tests (Phase 1)
- **auth_test.py** - Authentication load via cookie-based sessions (100 users, 5 min)
- **workspace_test.py** - Workspace + project CRUD (200 users, 10 min)
- **api_test.py** - Core API endpoints: templates, workspaces, projects (50 users, 3 min)
### Complex Tests (Phase 2)
- **multi_tenant_test.py** - Multi-tenant simulation (150 users, 30 min)
- **cold_start_test.py** - Agent runtime cold start stress (100 users, 15 min)
- **chat_heavy_test.py** - Chat-heavy workload (100 users, 20 min)
- **dry_run_simulation.py** - Concurrent user dry-run scenario (15-30 users, 10-15 min)
- **data_intensive_test.py** - Data operations (50 users, 20 min) [stub]

## Agent Runtime Quick Start

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

## Directory Structure

```
tests/load/
├── locustfiles/        # Test definitions
│   ├── common/         # Shared utilities (auth, config)
│   ├── simple/         # Phase 1 tests
│   └── complex/        # Phase 2 tests (incl. agent_runtime_test.py)
├── scripts/            # Automation scripts
├── reports/            # Generated reports (.html, .csv)
├── env.example         # Environment template
└── requirements.txt    # Python dependencies
```

## Authentication

All tests use **Better Auth cookie-based sessions**. The Locust `HttpSession`
automatically stores and sends session cookies between requests — no `Authorization`
headers needed.

The auth flow:
1. `POST /api/auth/sign-up/email` — creates account + sets session cookie
2. `POST /api/auth/sign-in/email` — logs in + sets session cookie
3. Subsequent requests automatically include the cookie

## Key Scripts

| Script | Purpose |
|--------|---------|
| `scripts/setup.sh` | Install dependencies and setup environment |
| `scripts/run_agent_runtime.sh` | Run agent runtime load test (primary) |
| `scripts/run_simple.sh` | Run simple test suite |
| `scripts/run_complex.sh` | Run complex test suite |
| `scripts/run_dry_run.sh` | Run dry-run simulation |
| `scripts/run_enhanced_tests.sh` | Run enhanced (smaller) test suite |
| `scripts/analyze_results.py` | Analyze results |

## API Endpoints Tested

| Endpoint | Method | Used By |
|----------|--------|---------|
| `/api/auth/sign-up/email` | POST | All tests (auth) |
| `/api/auth/sign-in/email` | POST | All tests (auth) |
| `/api/auth/get-session` | GET | Session verification |
| `/api/workspaces` | GET/POST/PATCH/DELETE | workspace_test, dry_run |
| `/api/projects` | GET/POST | All project tests |
| `/api/projects/:id/chat` | POST | Chat tests (via API proxy) |
| `/api/projects/:id/chat/status` | GET | Status checks |
| `/api/projects/:id/agent-proxy/*` | ALL | agent_runtime_test (direct pod) |
| `/api/projects/:id/sandbox/url` | GET | agent_runtime_test (warm claim) |
| `/api/health` | GET | Health checks |
| `/api/templates` | GET | api_test |
| `/api/warm-pool/status` | GET | agent_runtime_test (preflight) |

## Success Criteria

**Simple Tests:**
- Error rate < 1%
- P95 latency < 2s
- P99 latency < 5s

**Agent Runtime Tests:**
- Warm start (pool claim): < 15s p95
- Health check: < 2s p99
- Chat response: < 30s p95
- Error rate: < 5%

**Complex Tests:**
- Error rate < 5%
- P95 latency < 3s
- No resource exhaustion
- Knative scales properly
