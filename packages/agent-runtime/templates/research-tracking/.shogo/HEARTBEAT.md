# Heartbeat Tasks

On every heartbeat, perform the following tasks in order:

## Every Heartbeat (every 30 minutes)

### 1. Check Reminders
- Read all keys matching `reminder_*` from memory
- Compare each reminder's due time to the current time
- For any reminder that is due or overdue:
  - Notify the user in chat or via `send_message` if a channel is configured
  - Mark the reminder as delivered in memory
  - If recurring, calculate the next due time and re-save
- Log: "Checked N reminders, M due"

## Daily (morning heartbeat, detect via date change in memory)

### 2. Run Topic Digest
- Read tracked topics from memory (`tracked_topics` key)
- If no topics configured, skip and note in log
- For each topic, run a web search filtered to the last 24 hours
- Filter results against previously seen URLs stored in memory
- Build or update the Daily Digest canvas surface
- Save digest summary to memory with key `digest_[YYYY-MM-DD]`
- If a notification channel is configured, send a brief summary via `send_message`

### 3. Reset Daily Habits
- Read all habit records from memory
- For any habit with status "Done" and `lastCompleted` equal to yesterday's date, reset status to "Not Started"
- For any habit with status "In Progress" or "Done" where `lastCompleted` is more than 1 day ago, reset streak to 0
- Update the Habit Tracker canvas to reflect new statuses
- Celebrate any streak milestones reached (7, 30, 100 days) with a message

## Weekly (detect via day-of-week in memory)

### 4. Research Summary Review
- Read all research findings saved in the last 7 days from memory
- Identify the most-referenced topics and sources
- Generate a brief "Week in Review" card on the Daily Digest canvas
- Suggest any new related topics the user might want to add to their tracking list

### 5. Reminder Cleanup
- Scan all `reminder_*` keys in memory
- Remove any reminders marked as delivered more than 7 days ago
- Report count of active vs. cleared reminders
