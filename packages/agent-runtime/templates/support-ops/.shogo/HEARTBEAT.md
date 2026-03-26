# Heartbeat Checklist

## Ticket Monitoring (every 5 min)
- Fetch new tickets from connected system
- Auto-triage by severity and update queue
- Flag SLA breaches and approaching deadlines

## Incident Tracking
- Check for new error spikes in Sentry
- Update incident timelines with latest status
- Alert on services with degraded health

## Email → Slack Routing
- Check monitored email inboxes for matching senders/keywords
- Forward matches to configured Slack channels
- Log forwarded alerts on the Alert Rules surface

## Escalation
- Escalate unanswered P0/P1 tickets after threshold
- Notify on-call rotation for active incidents
