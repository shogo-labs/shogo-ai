# Agent Strategy

## Canvas Surfaces

This agent manages the following canvas surfaces:

1. **Research Dashboard** — Deep-dive findings for a specific topic: key metrics, takeaways, source table, and category breakdown. Created on demand via the `research-deep` skill.
2. **Daily Digest** — A date-stamped digest of new developments across all tracked topics, updated each morning by the `topic-tracker` skill.
3. **Habit Tracker Board** — A kanban-style board for research habits (daily reading, note review, etc.) with streaks and status columns, managed by the `habit-track` skill.
4. **Reminders Panel** — An inline view of upcoming and overdue reminders surfaced during heartbeat checks via the `reminder-manage` skill.
5. **Topic Registry** — A persistent list of tracked topics with last-checked timestamps and article counts, used as the source of truth for digest generation.

## Core Workflow

1. **On first run** — Check memory for tracked topics. If none exist, prompt the user to configure topics they want to follow.
2. **On heartbeat** — Run the topic tracker to search for new developments, check reminders for anything due, and reset daily habits if it's a new day.
3. **On user request** — Detect intent: deep research, topic management, reminder setting, habit update, or digest review. Route to the appropriate skill.
4. **After research** — Persist findings to memory with topic tags and timestamps so future searches can filter for genuinely new content.
5. **On notification** — If a channel is configured, send a concise summary of the daily digest and any due reminders via `send_message`.

## Skill Workflows

### `research-deep`
- Triggered by: "research [topic]", "deep dive on [topic]", "tell me everything about [topic]"
- Run 2-3 distinct web searches, visit top results, extract key data points
- Build a Research Dashboard canvas with Metric components, a Key Takeaways card, a source DataList, and a category comparison table
- Define an Article schema via `canvas_api_schema` (title, source, summary, url, category, read status)
- Persist findings to memory tagged by topic and date

### `topic-tracker`
- Triggered by: heartbeat (daily), or "what's new on [topic]"
- Read tracked topics from memory, search for last-24h developments per topic
- Filter out previously seen articles using memory-stored URLs
- Build or update the Daily Digest canvas with a date badge, per-topic cards, and a full article table
- Save digest to memory and optionally notify via `send_message`

### `reminder-manage`
- Triggered by: "remind me to [X] at [time]", heartbeat checks, "what reminders do I have"
- Parse natural language time expressions into structured reminder objects
- Store with key `reminder_[timestamp]`, check on every heartbeat, notify when due
- Support recurring reminders by re-scheduling after delivery

### `habit-track`
- Triggered by: "add habit [name]", "done [habit]", "show my habits", morning heartbeat
- Maintain a kanban board with Not Started / In Progress / Done columns
- Use `canvas_api_schema` for habit CRUD with streak tracking
- Celebrate milestones at 7, 30, and 100-day streaks
- Reset all Done habits to Not Started on morning heartbeat

## Recommended Integrations

Search for these in the integrations panel to enhance this agent:

- **`web search`** — Core capability for all research and topic tracking tasks
- **`slack`** — Send daily digests and reminder notifications to a channel
- **`notion`** — Export research findings and digests to a Notion database
- **`gmail`** — Receive digest summaries or set reminders via email
- **`google calendar`** — Sync reminders with calendar events

## Canvas Patterns

- **Metric Grid** — Use for key stats at the top of Research Dashboards (article count, source count, date range, top category)
- **Card** — Use for Key Takeaways, per-topic digest summaries, and individual habit items
- **DataList / Table** — Use for source lists, article tables, and reminder lists
- **Kanban Grid** — Use for the Habit Tracker board (3 columns: Not Started, In Progress, Done)
- **Badge** — Use for date labels on digests, streak counts on habits, and priority indicators on reminders
- **Tabs** — Use on the Research Dashboard to separate Overview, Sources, and Category Breakdown
