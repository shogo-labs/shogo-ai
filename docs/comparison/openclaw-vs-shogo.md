# OpenClaw vs Shogo: Agent Platform Comparison Report

**Date:** February 19, 2026
**Platforms:** OpenClaw v2026.2.17 vs Shogo (local dev)
**Method:** Built 3 identical use-case agents on both platforms, compared architecture, DX, and capabilities

---

## Executive Summary

Both OpenClaw and Shogo share a remarkably similar architecture: file-based workspace configuration (AGENTS.md, SOUL.md, IDENTITY.md, HEARTBEAT.md, MEMORY.md), heartbeat systems, skills/triggers, cron scheduling, channel adapters, and sandbox execution. This architectural similarity makes the comparison particularly valuable -- the platforms are solving the same problem with different trade-offs.

**Key finding:** OpenClaw has broader channel support (50+ vs 2), a larger skill ecosystem (5,700+ community skills), and more mature CLI tooling, while Shogo offers a superior visual builder experience, tighter MCP integration, and a managed cloud deployment story. Shogo's agent runtime is functionally competitive for the core use cases but has significant gaps in channels, skill discovery, memory search, and browser automation that should be prioritized.

**Runtime testing:** 2 of 3 Shogo agents passed end-to-end testing (Task Manager and GitHub Monitor worked correctly with proper tool usage and accurate results). The Research agent started correctly but was interrupted by UI issues (HMR reload wiping test chat state, routing bug). Testing also uncovered a dead code bug in the HMR configuration (now fixed) and that test chat history is not persisted server-side.

---

## 1. Environment Setup

### OpenClaw

| Step | Command | Time | Notes |
|------|---------|------|-------|
| Install Node 22 | `nvm install 22` | 8s | Requires Node 22+ (Shogo uses Node 20/Bun) |
| Install OpenClaw | `npm install -g openclaw@latest` | 48s | 670 packages, some deprecated warnings |
| Configure | `openclaw config set gateway.mode local` | 3s | Single command |
| Verify | `openclaw doctor` | 16s | Detailed health check with fix suggestions |
| Fix issues | `openclaw doctor --fix` | 4s | Auto-fixes config and creates directories |

**Total time to ready:** ~2 minutes
**Friction points:** Requires Node 22 specifically (not compatible with Node 20). Doctor check is helpful but verbose. Memory search requires separate embedding provider setup.

### Shogo

| Step | Action | Time | Notes |
|------|--------|------|-------|
| Start API | `bun run api:dev` | ~5s | Already running in terminal |
| Start Web | `bun run web:dev` | ~3s | Already running on :5173 |
| Navigate | Open http://localhost:5173 | 1s | Web-first experience |

**Total time to ready:** ~10 seconds (assuming infra running)
**Friction points:** Requires docker infra (postgres, redis, minio) plus API + web servers. More setup, but once running the experience is smoother. No CLI health check equivalent.

### Verdict: Setup

OpenClaw wins on **first-time setup** -- single `npm install -g` + `openclaw onboard` gets you running. Shogo wins on **ongoing DX** -- web UI is always there once dev servers are up. Shogo should add a CLI health check command (`shogo doctor`) and simplify initial bootstrapping.

---

## 2. Agent Creation Experience

### Use Case 1: GitHub Repository Monitor

#### OpenClaw

**Process:** Created workspace directory, wrote 7 files manually (IDENTITY.md, SOUL.md, AGENTS.md, USER.md, HEARTBEAT.md, MEMORY.md, skills/check-github.md). Registered as multi-agent via `openclaw config set agents.list [...]`.

**Steps:** 8 file creates + 1 config command = **~5 minutes**

**Observations:**
- No interactive creation wizard for agents
- Must know the workspace file schema
- `openclaw agents list` immediately reads IDENTITY.md and shows agent emoji/name
- Multi-agent registration is a single JSON config set
- Skill creation is straightforward: Markdown + YAML frontmatter
- No validation of skill triggers or required tools

#### Shogo

**Process:** Clicked "Agent" mode, typed description, builder AI auto-configured everything using the `github-monitor` template.

**Steps:** 1 text prompt = **~75 seconds**

**Observations:**
- Builder AI used `agent_template_copy` MCP tool to initialize from template
- Automatically read all files, then customized IDENTITY, SOUL, AGENTS, HEARTBEAT, MEMORY, config.json
- Set heartbeat to 900s (15 min) as requested
- Created structured MEMORY.md with delta-detection state tracking
- Did NOT create a skills directory for this agent (gap -- the template includes a skill but the builder didn't copy it)
- Builder used ~7 credits for the full configuration
- Builder provided a structured summary of what was configured with next steps

**Gap found:** The builder sometimes fails to create skills from templates. The `agent_template_copy` tool may not handle the `skills/` subdirectory properly.

### Use Case 2: Web Research & Daily Digest

#### OpenClaw

**Process:** 9 files created: IDENTITY, SOUL, AGENTS, USER, HEARTBEAT, MEMORY + 2 skills (web-research.md, daily-digest.md).

**Steps:** 9 file creates = **~6 minutes**

#### Shogo

**Process:** Typed description, builder created and configured all files including 2 skills.

**Steps:** 1 prompt = **~90 seconds** (builder made many tool calls)

**Observations:**
- Builder attempted MCP `identity_set` tool 4 times -- all failed silently, then fell back to Write tool
- This means the MCP tool integration has a reliability issue in the builder session
- Builder eventually configured everything correctly via direct file writes
- Skills were created with detailed instructions, scoring criteria, and example output
- Builder created a SETUP_GUIDE.md bonus file (nice touch)
- Config correctly set timezone to America/New_York and heartbeat to 3600s

**Gap found:** MCP builder tools (`identity_set`, `identity_get`) had connection issues -- the builder had to fall back to raw file writes. This suggests the MCP server stdio subprocess isn't always reliably connected.

### Use Case 3: Personal Task Manager / CRM

#### OpenClaw

**Process:** 11 files created: workspace files + tasks.md, contacts.md + 2 skills (task-manager.md, contact-crm.md).

**Steps:** 11 file creates = **~7 minutes**

#### Shogo

**Process:** Builder configured from personal-assistant template, created all files including seeded data.

**Steps:** 1 prompt = **~2 minutes** (two Claude Code sessions ran)

**Observations:**
- Builder ran TWO separate coding sessions (appeared to retry/restart)
- First session wrote task/contact files but may not have completed
- Second session read the already-created files and enhanced them
- Created comprehensive skills with detailed examples and workflows
- Seeded contacts.md with 6 contacts including stale contact detection
- Seeded tasks.md with 11 tasks across priorities
- Both skills reference `[filesystem, memory]` tools -- but the actual tool is called `read_file`/`write_file`, not `filesystem` (potential runtime mismatch)

**Gap found:** Skills reference tool group names (e.g., `filesystem`) that don't match actual gateway tool names (`read_file`, `write_file`). This mismatch could affect skill-tool gating at runtime.

### Verdict: Agent Creation

Shogo wins decisively on **speed and accessibility** -- natural language -> configured agent in 60-120 seconds vs 5-7 minutes of manual file editing. However, the builder has reliability issues: MCP tool failures, inconsistent skill creation, and dual-session runs. OpenClaw wins on **transparency and control** -- every file is visible and manually managed, no magic or failures.

---

## 3. Feature-by-Feature Comparison Matrix

| Feature | OpenClaw | Shogo | Gap Severity |
|---------|----------|-------|-------------|
| **Installation** | `npm install -g` (1 command) | Requires docker + API + web servers | Medium |
| **Agent creation** | Manual file editing | AI builder chat (natural language) | Shogo wins |
| **Templates** | Community + awesome-agents repo | 5 built-in templates (embedded in code) | Medium |
| **Channels** | **50+ (WhatsApp, Telegram, Discord, Slack, iMessage, Signal, Teams, IRC, Matrix, LINE...)** | **2 (Telegram, Discord)** | **Critical** |
| **Skills (bundled)** | 50 bundled (8 ready on macOS) | 0 bundled (created per-agent) | High |
| **Skills (community)** | 5,700+ via ClawHub marketplace | None (no marketplace) | High |
| **Skill gating** | OS, bins, env, config filters | Keyword/regex trigger only | Medium |
| **Memory storage** | MEMORY.md + daily logs (same as Shogo) | MEMORY.md + daily logs | Parity |
| **Memory search** | **Vector search (SQLite-vec, BM25 + embeddings)** | **Text search only** | **Critical** |
| **Session compaction** | LLM summarization with memory flush | LLM summarization | Low |
| **Cron scheduling** | Cron expressions, intervals, one-shot, webhook delivery | Interval-only (seconds), max 20 jobs | Medium |
| **Heartbeat** | Configurable interval, quiet hours, active hours | Configurable interval, quiet hours | Parity |
| **Shell execution** | Sandboxed (Docker), configurable per-agent | Sandboxed (Docker), blocked commands list | Parity |
| **Web fetching** | `web` (similar to Shogo) | `web` (50k chars, 15s timeout) | Parity |
| **Browser automation** | **Playwright-based headless browser** | **None (HTTP-only web)** | **High** |
| **Multi-agent** | Full isolation (workspace, sessions, routing) | One agent per project (managed isolation via K8s) | Medium |
| **Agent routing** | Channel/account/peer/guild/role routing rules | N/A (one agent per project) | Medium |
| **Hook system** | 12 event types, bundled + custom hooks | Hook system (similar events) | Parity |
| **LLM providers** | Claude, GPT, Gemini, DeepSeek, Ollama, vLLM | Anthropic only (via AI proxy) | High |
| **Model selection** | Per-agent, per-provider override | Per-agent (via config.json) | Low |
| **CLI tools** | `openclaw doctor`, `status`, `agents`, `skills`, `config` | None (web-first) | Medium |
| **Web UI** | Dashboard (basic) | **Full IDE-like interface with builder chat, workspace editor, test chat, logs** | Shogo wins |
| **Deployment** | Local daemon (launchd/systemd) | **Kubernetes (Knative), managed cloud** | Shogo wins |
| **Cost tracking** | Open source (API costs only) | Credit system (Haiku: 0.2/msg, Sonnet: 0.5/msg) | Different model |
| **Security scanning** | VirusTotal skill scanning, CVE tracking | Basic blocked commands list | Medium |
| **SOUL.md** | Yes | Yes | Parity |
| **BOOT.md** | Yes (startup script) | No | Low |
| **TOOLS.md** | Yes (local setup notes) | Yes | Parity |
| **Loop detection** | Circuit breaker (max 10 iterations) | Circuit breaker (configurable) | Parity |
| **Observability** | Logs, status endpoint, session history | Logs panel, status endpoint, session history | Parity |

---

## 4. Architecture Comparison

```
OpenClaw Architecture:
┌────────────────────┐    ┌──────────────┐    ┌─────────────┐
│  CLI / Dashboard   │───>│   Gateway    │───>│  LLM API    │
└────────────────────┘    │  (WebSocket) │    │  (any)      │
                          │              │    └─────────────┘
┌────────────────────┐    │  - Heartbeat │
│  50+ Channels      │<──>│  - Sessions  │    ┌─────────────┐
│  (WhatsApp,Tele,   │    │  - Skills    │───>│  Workspace   │
│   Discord,Slack..) │    │  - Memory    │    │  (files)     │
└────────────────────┘    │  - Cron      │    └─────────────┘
                          │  - Hooks     │
                          │  - Sandbox   │    ┌─────────────┐
                          └──────────────┘───>│  ClawHub     │
                                              │  (skills)    │
                                              └─────────────┘

Shogo Architecture:
┌────────────────────┐    ┌──────────────┐    ┌─────────────┐
│  Web UI (Vite)     │───>│   API (Hono) │───>│  AI Proxy   │
│  - Builder Chat    │    │  - Auth      │    │  (Anthropic) │
│  - Test Chat       │    │  - Projects  │    └─────────────┘
│  - Workspace Panel │    │  - Billing   │
│  - Logs Panel      │    └──────┬───────┘    ┌──────────────┐
└────────────────────┘           │            │  Agent       │
                                 │            │  Runtime     │
┌────────────────────┐           ├───────────>│  (gateway)   │
│  2 Channels        │<─────────>│            │  - Heartbeat │
│  (Telegram,        │           │            │  - Sessions  │
│   Discord)         │           │            │  - Skills    │
└────────────────────┘    ┌──────┴───────┐    │  - Memory    │
                          │  MCP Server  │    │  - Cron      │
                          │  (builder    │    │  - Hooks     │
                          │   tools)     │    │  - Sandbox   │
                          └──────────────┘    └──────────────┘
                                                     │
                          ┌──────────────┐           │
                          │  Kubernetes  │<──────────┘
                          │  (Knative)   │
                          │  - S3 sync   │
                          │  - Auto-scale│
                          └──────────────┘
```

### Key Architectural Differences

1. **Single process vs managed pods:** OpenClaw runs as a single local daemon; Shogo deploys isolated Knative pods per agent with S3 workspace sync.

2. **Builder paradigm:** OpenClaw uses manual files + CLI; Shogo uses an AI builder (Claude Code) that configures agents via MCP tools.

3. **LLM routing:** OpenClaw connects directly to any provider; Shogo routes through an AI proxy with credit billing.

4. **Channel philosophy:** OpenClaw treats channels as first-class integrations with per-channel SDKs; Shogo implements a minimal adapter interface.

---

## 5. Detailed Gap Analysis & Recommendations

### CRITICAL Priority

#### 5.1 Channel Support (Shogo: 2, OpenClaw: 50+)

This is the single largest competitive gap. Users building autonomous agents need to reach them via their existing messaging apps.

**Recommended additions (priority order):**
1. **Slack** -- enterprise users (#1 request for team bots)
2. **WhatsApp** -- personal assistant use cases (highest user reach)
3. **Email (IMAP/SMTP)** -- universal, critical for CRM/task agents
4. **Webhook/HTTP** -- generic adapter for custom integrations

**Estimated effort:** Each channel adapter is ~200-400 lines following the existing `ChannelAdapter` interface pattern in `packages/agent-runtime/src/channels/`. Telegram and Discord implementations are good reference implementations.

**File to extend:** `packages/agent-runtime/src/channels/`

#### 5.2 Memory Search (Shogo: text, OpenClaw: vector + BM25)

OpenClaw supports semantic memory search with SQLite-vec embeddings, hybrid BM25 + vector similarity, MMR re-ranking, and temporal decay. Shogo's `memory_search` tool does basic text matching.

**Recommendation:** Add embedding-based memory search using SQLite-vec (same approach as OpenClaw). This enables agents to recall relevant context from weeks of accumulated memory.

**Estimated effort:** Medium (2-3 days). Add an embedding pipeline to the memory write path and a vector search endpoint to `memory_search` in `packages/agent-runtime/src/tools/mcp-server.ts`.

### HIGH Priority

#### 5.3 Browser Automation

OpenClaw agents can control a headless browser via Playwright for web scraping, form filling, and UI testing. Shogo agents are limited to `web` (plain HTTP GET).

**Recommendation:** Add a `browser` tool to the gateway tools that launches a Playwright browser for structured web interactions. This unblocks web scraping use cases where `web` gets raw HTML.

**File to extend:** `packages/agent-runtime/src/gateway-tools.ts`

**Estimated effort:** Medium-high (3-5 days). Requires Playwright dependency, sandbox considerations, and a resource management strategy.

#### 5.4 Skill Ecosystem & Discovery

OpenClaw has 5,700+ community skills via ClawHub with `clawhub install/search/sync`. Shogo has no skill marketplace -- skills are created per-agent.

**Recommendation (phased):**
1. **Phase 1:** Bundle 10-20 useful skills with agent-runtime (weather, github, web-research, summarize, etc.)
2. **Phase 2:** Add a skill import mechanism (`shogo skill install <url>`)
3. **Phase 3:** Build a skill marketplace/gallery in the web UI

**Estimated effort:** Phase 1: 2-3 days. Phase 2: 1 week. Phase 3: 2-3 weeks.

#### 5.5 Multi-Provider LLM Support

OpenClaw supports Claude, GPT, Gemini, DeepSeek, Grok, and local models (Ollama, vLLM). Shogo is Anthropic-only via the AI proxy.

**Recommendation:** Abstract the LLM provider in the agent runtime to support OpenAI-compatible endpoints. This enables GPT, Gemini (via compatibility layer), and local models.

**File to extend:** Agent gateway's AI call path and `config.json` model configuration.

**Estimated effort:** Medium (2-3 days). The AI proxy already has the OpenAI-compatible endpoint shape.

### MEDIUM Priority

#### 5.6 CLI Tooling

OpenClaw has a polished CLI: `openclaw doctor`, `openclaw status`, `openclaw agents list`, `openclaw skills list`, `openclaw config set`. Shogo is web-only.

**Recommendation:** Add a minimal CLI for agent management:
- `shogo doctor` -- health check (db, redis, minio, API)
- `shogo agents list` -- list active agents
- `shogo agents status <id>` -- show agent runtime status
- `shogo logs <id>` -- tail agent logs

**Estimated effort:** Low-medium (2-3 days). Can use commander + API calls.

#### 5.7 Cron Expression Support

OpenClaw supports full 5/6-field cron expressions, fixed intervals, and one-shot timestamps. Shogo only supports interval-based scheduling (seconds).

**Recommendation:** Add cron expression parsing (via `cron-parser` package) to `packages/agent-runtime/src/cron-manager.ts`. Keep interval-based as default for simplicity.

**Estimated effort:** Low (1 day).

#### 5.8 Template Externalization

Shogo templates are embedded in `mcp-server.ts` (lines 624-714). OpenClaw templates are file-based and community-extensible.

**Recommendation:** Move templates to a `templates/` directory with one folder per template. Add a template gallery in the web UI.

**File to refactor:** `packages/agent-runtime/src/tools/mcp-server.ts` (the `getAgentTemplate()` function).

**Estimated effort:** Low (1 day).

#### 5.9 Skill Tool Name Mismatch

During testing, the Shogo builder created skills referencing tool groups like `[filesystem, memory]` but the actual gateway tools are named `read_file`, `write_file`, `memory_read`, `memory_write`. This mismatch could prevent proper skill-tool gating.

**Recommendation:** Either (a) add tool group aliases in the skill loader, or (b) update the builder's system prompt to use correct tool names.

**Estimated effort:** Low (few hours).

### LOW Priority

#### 5.10 BOOT.md Support

OpenClaw supports a `BOOT.md` file executed on gateway startup for initial setup tasks. Shogo doesn't have this.

**Recommendation:** Add optional `BOOT.md` support in `packages/agent-runtime/src/gateway.ts` startup sequence.

**Estimated effort:** Low (few hours).

#### 5.11 Security Scanning

OpenClaw scans skills with VirusTotal and has a built-in code safety scanner. Shogo has a blocked commands list for shell execution.

**Recommendation:** Add skill content scanning (regex-based blocklist for dangerous patterns) when skills are loaded.

**Estimated effort:** Low (1 day).

---

## 6. Builder Reliability Issues Observed

During the Shogo agent creation process, several issues were observed:

1. **MCP tool failures:** The builder attempted `identity_set` MCP calls 4 times in succession, all failing silently. It then fell back to direct file writes. The MCP stdio subprocess may not be reliably connected during builder sessions.

2. **Missing skills from templates:** The GitHub Monitor template includes a `skills/check-github.md` file, but the builder didn't create the skills directory when copying the template. The `agent_template_copy` tool may not handle subdirectories.

3. **Dual session runs:** The Task Manager agent appeared to run two separate builder sessions, suggesting the first may have timed out or errored. The second session read files from the first and enhanced them.

4. **Tool name inconsistency:** Skills created by the builder reference `[filesystem, memory]` tool groups, but the gateway tools are individually named (`read_file`, `write_file`, etc.).

**Recommendation:** Add integration tests for the builder flow that verify:
- MCP tool calls succeed in the builder context
- Template copy includes all subdirectories
- Skills reference valid tool names

---

## 7. Observations from Agent Configuration Quality

### OpenClaw (manual)
- Configurations are minimal and focused
- No validation of HEARTBEAT.md checklist items
- Skills are simple and concise
- Memory initialization requires manual setup
- Consistent format across all agents

### Shogo (AI builder)
- Configurations are rich and detailed (more comprehensive HEARTBEAT checklists, structured MEMORY state tracking)
- Builder adds structured delta-detection logic in MEMORY.md
- Skills include scoring criteria, example outputs, and detailed workflow steps
- Builder provides helpful summaries and next-step guidance
- Some inconsistency between sessions (different levels of detail)

**Verdict:** The AI builder produces higher-quality, more detailed configurations than manual editing. The structured state tracking in MEMORY.md (with "last check timestamp" and "open PR IDs" sections) is particularly valuable for delta detection. This is a genuine DX advantage for Shogo.

---

## 8. Agent Runtime Testing Results

All three Shogo agents were tested via the Test Chat panel in Shogo Studio. Two of three ran successfully end-to-end.

### Test 1: Personal Task Manager (PASS)

**Prompt:** "Read the tasks.md file and tell me what tasks I have and which are overdue"

**Result:** Agent correctly:
- Used `read_file` tool to read `tasks.md` from its workspace
- Parsed all 11 tasks with correct priority groupings (High/Medium/Low)
- Calculated that all tasks with 2025 due dates are ~1 year overdue (today is Feb 19, 2026)
- Listed 3 completed tasks separately
- Provided a structured summary with overdue counts

**Tool usage:** `read_file` (correct) -- displayed as "Read tasks.md" in the UI.

### Test 2: GitHub Repository Monitor (PASS)

**Prompt:** "Check the current status of the openclaw/openclaw repository. What are the latest open issues and PRs?"

**Result:** Agent demonstrated intelligent fallback behavior:
1. First tried `exec` with `gh repo view openclaw/openclaw` (GitHub CLI)
2. Detected `gh` wasn't authenticated, tried `gh auth status` to confirm
3. Fell back to `web` on GitHub's web pages (3 sequential fetches)
4. Extracted real data: 210k+ stars, 38.8k+ forks, 12,648 commits
5. Listed 8 real open issues from today with issue numbers (#20827, #20826, etc.)
6. Listed 5 real open PRs from today with numbers (#20833, #20832, etc.)
7. Reported totals: 4,039 open issues, 3,925 open PRs

**Tool usage:** `exec` -> `exec` -> `web` x3 (all correct). Displayed as "Bash" and "WebFetch" in UI.

### Test 3: Research & Daily Digest (PARTIAL -- interrupted by UI issues)

**Prompt:** "Research what's trending on Hacker News today related to AI agents and MCP protocol"

**Result:** Agent started correctly:
1. Used `web` (displayed as "WebSearch") to search for HN + AI agents + MCP
2. Ran a second search with `site:news.ycombinator.com` scoping
3. Ran a third search with date-specific query

**Interruption:** Two separate UI issues prevented completing this test:
- First attempt: HMR reload (from code changes in the workspace) caused a full page refresh, wiping the test chat state
- Second attempt: A routing bug auto-navigated the browser away from the project page to a different project

### UI Issues Discovered During Testing

| Issue | Severity | Description |
|-------|----------|-------------|
| **Test chat not persisted** | High | Test chat messages are in-memory only. Page refresh/HMR reload wipes all test chat history. Builder chat persists but test chat does not. |
| **HMR wipes active streams** | High | Vite HMR reloads during active test chat responses kill the stream and lose the response. The `enableHMR` config variable was defined but never wired into the `hmr:` setting (dead code bug, now fixed). |
| **Routing/redirect bug** | Medium | When navigating to certain projects, the app occasionally auto-redirects to a different project page after a few seconds. |
| **Send button initially disabled** | Low | The test chat send button remains disabled while the runtime boots. No loading indicator explains this -- just "Connecting to agent..." placeholder text. |

### Comparison: OpenClaw vs Shogo Test Chat

| Aspect | OpenClaw | Shogo |
|--------|----------|-------|
| **Testing method** | Direct CLI interaction or channel message | Built-in Test Chat panel in web UI |
| **History persistence** | Full session history stored | Test chat history lost on refresh |
| **Tool visibility** | Raw tool calls in logs | Collapsible tool call buttons (Read, Bash, WebFetch, etc.) |
| **Streaming** | Terminal streaming | SSE streaming with real-time UI updates |
| **Interruption recovery** | Process stays running | Stream lost if page reloads |

---

## 9. Prioritized Improvement Roadmap

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| P0 | Add Slack channel adapter | 2 days | Unlocks enterprise use cases |
| P0 | Add WhatsApp channel adapter | 3 days | Unlocks personal assistant use cases |
| P0 | Add vector memory search (SQLite-vec) | 3 days | Enables long-term agent memory recall |
| P1 | Persist test chat history server-side | 1 day | Test chat survives page refresh/HMR |
| P1 | Fix MCP builder tool reliability | 1 day | Reduces builder errors and retries |
| P1 | Fix template copy (include subdirs) | Few hours | Skills from templates actually work |
| P1 | Add browser tool (Playwright) | 4 days | Enables web scraping agents |
| P1 | Bundle 10-20 common skills | 3 days | Faster agent setup, competitive with OpenClaw |
| P1 | Add email channel (IMAP/SMTP) | 2 days | Universal messaging support |
| P2 | Multi-provider LLM support | 3 days | Removes vendor lock-in |
| P2 | CLI tooling (doctor, agents, logs) | 3 days | Developer experience for power users |
| P2 | Cron expression support | 1 day | More flexible scheduling |
| P2 | Externalize templates to files | 1 day | User-customizable templates |
| P2 | Fix skill tool name mismatch | Few hours | Correct skill-tool gating |
| P3 | Skill marketplace/gallery | 2-3 weeks | Community ecosystem growth |
| P3 | Webhook/HTTP channel adapter | 1 day | Generic integration point |
| P3 | BOOT.md support | Few hours | Startup automation |
| P3 | Skill security scanning | 1 day | Safety for community skills |

---

## 10. What Shogo Does Better Than OpenClaw

Despite the gaps, Shogo has genuine advantages:

1. **AI-powered builder:** Creating an agent via natural language in 60-120 seconds is dramatically better than manually editing 7-11 files. This is Shogo's killer feature.

2. **Visual workspace IDE:** The tabbed interface (Test Chat, Workspace, Skills, Heartbeat, Channels, Logs) provides a far better overview than OpenClaw's file-based approach.

3. **Managed deployment:** Kubernetes + Knative + S3 sync means agents can run in the cloud with auto-scaling. OpenClaw is local-only (requires self-hosted infrastructure for always-on).

4. **Configuration quality:** The AI builder produces richer, more structured configurations than what a developer would write manually (detailed HEARTBEAT checklists, structured MEMORY state tracking, comprehensive skill workflows).

5. **MCP integration:** The MCP tool system provides a clean separation between builder tools and runtime tools, with proper JSON-RPC protocol.

6. **Credit billing:** Built-in usage tracking and billing makes Shogo viable as a commercial platform.

---

## 11. Conclusion

Shogo's agent runtime is architecturally sound and competitively capable at the core level. The file-based workspace, heartbeat, skills, memory, and cron systems are well-implemented. The AI builder is a genuine competitive advantage.

The critical gaps are in **channel support** (2 vs 50+), **memory search** (text vs vector), and **browser automation** (none vs Playwright). Addressing the P0 and P1 items above would bring Shogo to feature parity with OpenClaw for the most common agent use cases, while maintaining its advantages in builder experience, deployment, and visual tooling.

The P0/P1 items represent approximately **2-3 weeks of focused development** and would dramatically expand the types of agents that can be built and deployed on Shogo.
