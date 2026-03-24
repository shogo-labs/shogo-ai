# Heartbeat Tasks

## Daily (every morning, on schedule)

- **Run auto-generate standup** — Pull 24h of GitHub and Slack activity, classify by developer, build the Daily Standup Dashboard canvas, and post the compiled summary to the configured Slack channel
- **Check for stale PRs** — Identify pull requests with no review activity in >2 days and surface them in the Blockers section of the standup canvas
- **Flag inactive developers** — Detect team members with zero commits, PR activity, or Slack messages in the last 24h and note them in the summary (possible PTO or blocker)

## Every heartbeat cycle

- **Check overdue action items** — Scan meeting notes memory for action items past their deadline; send a reminder to the owner via `send_message` if a channel is configured
- **Detect recurring blockers** — Compare today's blockers against the last 5 standups stored in memory; if the same blocker appears 3+ times, escalate with a highlighted alert in the canvas

## Weekly (on Monday heartbeat)

- **Generate velocity summary** — Aggregate the past week's standup data from memory: total PRs merged, issues closed, recurring blockers, and average team activity; post a weekly digest to the team channel
- **Archive sprint data** — Save the week's standup history to the Team Activity Feed canvas for long-term pattern tracking
