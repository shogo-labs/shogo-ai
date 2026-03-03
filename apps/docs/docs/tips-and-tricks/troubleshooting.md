---
sidebar_position: 4
title: Troubleshooting
slug: /tips-and-tricks/troubleshooting
---

# Troubleshooting

Common issues and how to resolve them.

## Chat issues

### AI not responding

1. Check your credit balance — you may have run out.
2. Wait a moment — the AI may be processing a complex request.
3. Try refreshing the page and resending your message.

### AI makes unwanted changes

If the AI changed something you didn't ask it to:
1. Revert to the previous version using [History](../features/history-and-checkpoints).
2. Re-send your request with more specific constraints:
   > "Only change [specific thing]. Don't modify [specific other thing]."

### AI seems confused about the agent

If the AI is making changes that don't make sense:
1. Start a new chat session by refreshing.
2. Provide context about what the agent is and what you're working on:
   > "This is a [type of agent]. I'm working on configuring [specific feature]. I need you to [specific request]."

## Heartbeat issues

### Heartbeat not running

1. Check that the heartbeat is enabled in the agent's configuration.
2. Verify the interval is set correctly.
3. Ask the AI: "Can you check if the heartbeat is enabled and show me the current schedule?"

### Heartbeat running but not doing anything useful

1. Check the HEARTBEAT.md file to see what tasks are defined.
2. Ask the AI: "What does my agent check on each heartbeat? Can you list the tasks?"
3. If the checklist is empty, describe what you want checked.

## Integration issues

### Tool not connecting

1. Open the **Capabilities > Tools** tab and try disconnecting and reconnecting the tool.
2. For OAuth tools, make sure you completed the authentication in the popup window.
3. For API key tools, verify the key is correct and has the required permissions.

### Alerts not being sent

1. Open the **Channels** tab and verify the channel is connected with valid credentials.
2. Check that the agent has something to alert about — it may be working but finding nothing.
3. Verify quiet hours aren't blocking alerts: "What are the current quiet hours?"

## Canvas issues

### Dashboard showing stale data

1. The canvas updates when the agent runs (heartbeat or chat interaction).
2. Ask the AI: "Can you refresh the dashboard data?"
3. Check if the heartbeat is running — stale data often means the heartbeat stopped.

### Dashboard layout not right

Describe what you want specifically:
> "The dashboard KPIs are too small. Make them larger with trend arrows. Move the chart above the table."

## Getting help

If you can't resolve an issue:

1. Check this documentation for guidance.
2. Try describing the problem to the AI in detail — it can often diagnose and fix issues.
3. Contact Shogo support through the **Help** menu.

:::tip Take a screenshot
When reporting issues, attaching a screenshot to your chat message or support request makes it much easier to diagnose the problem.
:::
