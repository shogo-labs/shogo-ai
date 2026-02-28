---
name: system-health
version: 1.0.0
description: Check system health, server status, and endpoint availability
trigger: "system health|check server|server status|is it up|uptime"
tools: [exec, web]
---

# System Health Check

When the user asks about system or server health:

1. **Local system** (if applicable):
   - Disk usage: `exec("df -h")`
   - Memory: `exec("free -h")` or `exec("vm_stat")` on macOS
   - CPU load: `exec("uptime")`
2. **Remote endpoints** (if URLs provided):
   - HTTP health check via web
   - Record response time and status code
3. **Report** findings with severity levels

## Output Format

### System Health Report

**Overall:** Healthy / Warning / Critical

**Local System:**
- Disk: 45% used (120GB free) ✅
- Memory: 6.2GB / 16GB (38%) ✅
- CPU Load: 1.2 (4 cores) ✅

**Endpoints:**
- https://api.example.com/health — 200 OK (120ms) ✅
- https://app.example.com — 503 Service Unavailable ❌

**Alerts:**
- [Any issues requiring attention]
