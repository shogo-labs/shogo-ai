# User Profile

## Identity
- **Name:** [Your name]
- **Role:** [e.g., Engineering Lead, SRE, DevOps Engineer, CTO]
- **Timezone:** [e.g., America/New_York]

## Incident Configuration
- **Alert channel:** [e.g., #incidents, #on-call, or a specific Slack channel ID]
- **On-call team:** [Names or handles of engineers to notify for P0/P1, e.g., @alice, @bob]
- **Escalation policy:** [e.g., "Page on-call immediately for P0, notify team channel for P1"]

## Services to Monitor
- **Service URLs:** [List of health check endpoints, e.g., https://api.yourapp.com/health, https://app.yourapp.com]
- **Critical services:** [Which services are P0 if down, e.g., "Payment API, Auth Service"]
- **Response time threshold:** [e.g., "Alert if response time > 2000ms"]

## Integrations
- **Error tracking:** [e.g., Sentry project slug or DSN]
- **Metrics platform:** [e.g., Datadog, Grafana, or "not connected yet"]
- **Deploy source:** [e.g., GitHub org/repo to watch for deploys]

## Preferences
- **Severity definitions:** [Customize P0/P1/P2/P3 if different from defaults, or leave blank to use defaults]
- **Quiet hours:** [e.g., "Do not send non-P0 alerts between 11pm–7am ET"]
- **Postmortem format:** [e.g., "Use our Notion template" or "Keep in canvas"]
