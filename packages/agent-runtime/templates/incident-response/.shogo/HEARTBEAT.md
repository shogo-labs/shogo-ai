# Heartbeat Tasks

{{AGENT_NAME}} runs the following tasks on each heartbeat cycle.

## Every Heartbeat (~30 minutes)

### 1. Health Check All Services
- Run the `health-check` skill against all configured service endpoints
- Update the Live Status Page canvas with current status and response times
- If any service is non-200 or response time exceeds threshold, trigger `escalation-alert` immediately
- Append results to memory for trend tracking

### 2. Check Open Incident Status
- Review memory for any open P0/P1 incidents logged in the last 4 hours
- If an incident is still open, post a status update to the incident channel: "Still investigating" or "Resolved — [summary]"
- If resolved, mark the incident as closed in memory and post a brief resolution note

### 3. Scan for New Error Spikes
- If Sentry is connected: query for new issues with spike activity in the last 30 minutes
- If a spike is detected that hasn't been triaged, trigger `incident-triage` automatically
- Log the scan result to memory regardless of findings

## Every 4 Hours

### 4. Digest Unescalated Issues
- Review memory for any P2/P3 issues logged since the last digest
- Compile a brief summary and post to the team channel: service name, issue type, frequency
- Clear the P2/P3 queue in memory after posting

## Daily (First Heartbeat After 09:00 User Timezone)

### 5. Incident Summary Report
- Pull all incidents from the last 24 hours from memory
- Build or update the Incident History canvas with new entries
- Post a daily summary to the incident channel: total incidents, P0/P1 count, MTTR, top recurring issues
- Flag any services with degraded uptime trends for review
