# Shogo Platform Performance SLOs

Service Level Objectives for the Shogo AI platform, informed by the
2026-02-20 staging dry-run failures.

## Project Runtime SLOs

| Metric | Target | Measurement |
|---|---|---|
| Cold start (warm pool hit) | < 10s p95 | Time from API request to project pod ready |
| Cold start (no warm pool) | < 60s p95 | Time from Knative service create to pod ready |
| Vite build (initial) | < 15s p95 | Time for first `vite build` after `bun install` |
| Vite rebuild (watch mode) | < 5s p95 | Time for incremental rebuild on file change |
| Health check pass | < 60s after start | Time from container start to `/health` returning 200 |
| Prisma setup | < 15s p95 | Time for `prisma generate` + `prisma db push` |

## Agent Runtime SLOs

| Metric | Target | Measurement |
|---|---|---|
| Cold start (warm pool hit) | < 15s p95 | Time from assignment to gateway ready |
| Tool execution | < 30s p95 | Time for single tool call |
| Agent loop detection | < 3 identical calls | Circuit breaker triggers |

## API Server SLOs

| Metric | Target | Measurement |
|---|---|---|
| Health check | < 2s p99 | `/api/health` response time |
| Auth endpoints | < 500ms p95 | Sign-up, sign-in, session check |
| Project creation | < 3s p95 | `POST /api/projects` response time |
| AI proxy (streaming) | < 10s to first token p95 | Time to first SSE event |
| Error rate | < 1% | 5xx responses / total requests |

## Infrastructure SLOs

| Metric | Target | Measurement |
|---|---|---|
| Pod scheduling | < 30s p95 | Time from pod create to container running |
| Image pull (pre-cached) | < 1s p95 | ECR image pull on node with cache |
| Image pull (cold) | < 90s p95 | ECR image pull on fresh node |
| Node autoscaling | < 5m | Time from pod pending to new node ready |
| Warm pool availability | >= 2 pods always | Available warm pods at any time |

## Load Test Thresholds

### Dry Run Scenario (15 concurrent users)
- Error rate: < 5%
- Cold start timeouts: 0
- P95 response time: < 5s (excluding cold starts)

### Production Load (50 concurrent users)
- Error rate: < 1%
- Cold start timeouts: 0
- P95 response time: < 3s (excluding cold starts)

### Agent Runtime Load (5–20 concurrent users)
- Agent cold start (warm pool): < 15s p95
- Health/status endpoints: < 2s p99
- File read/write: < 5s p95
- Dynamic app state: < 5s p95
- Chat (LLM round-trip): < 30s p95
- Error rate: < 5%

## Alerting Rules (SigNoz)

1. **Cold start > 120s** — Critical: Project pod failed to start
2. **Error rate > 5% for 5m** — Warning: System degradation
3. **Error rate > 10% for 2m** — Critical: System outage
4. **Pod restart loop** — Warning: Container crash-looping
5. **Node CPU > 80% for 10m** — Warning: Resource pressure
6. **Warm pool < 1 available** — Warning: Cold start risk
