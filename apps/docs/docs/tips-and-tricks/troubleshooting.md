---
sidebar_position: 4
title: Troubleshooting
slug: /tips-and-tricks/troubleshooting
---

# Troubleshooting

Common issues and how to resolve them.

## Preview issues

### Preview not loading

**Try these steps in order:**
1. Click the **Refresh** button in the preview panel.
2. Wait a few seconds — the app may still be building.
3. Check the chat for error messages from the AI.
4. Try switching to a different view tab and back to Preview.

### Preview shows old content

The preview auto-updates after each AI change. If it seems stuck:
1. Click **Refresh** in the preview.
2. If using multiple pages, navigate to the home route (`/`) and back.

### Layout looks broken

> "The layout on [page] is broken — elements are overlapping / misaligned. Can you fix the spacing, padding, and make sure the layout works correctly?"

If the issue persists, revert to the last working version and try describing the desired layout differently.

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

### AI seems confused about the project

If the AI is making changes that don't make sense:
1. Start a new chat session by refreshing.
2. Provide context about what the app is and what you're working on:
   > "This is a [type of app]. I'm working on the [page] page. I need you to [specific request]."

## Publishing issues

### Publish fails

If publishing gives an error:
1. Check the chat for build error messages.
2. Ask the AI to investigate:
   > "I'm getting an error when trying to publish. Can you check if there are any build issues and fix them?"
3. Try making a small change and publishing again.

### Published app doesn't match preview

The published app should match your preview. If it doesn't:
1. Make sure you published after your latest changes (click **Update**).
2. Clear your browser cache or try an incognito/private window.
3. Wait a moment — there may be a brief delay while the update propagates.

### Published app has errors

1. Go back to the project editor.
2. Test the issue in the preview.
3. Ask the AI to fix it:
   > "On the published app at [URL], [describe the issue]. Can you fix it?"
4. After fixing, click **Publish > Update** to push the fix live.

## Data issues

### Data not showing up

> "The [table/list] on [page] is showing empty even though I've added data. Can you check if the data is being loaded correctly?"

### Data disappeared

Your data is preserved even after changes. If data seems missing:
1. Check that you're looking at the right collection in the Database panel.
2. Check if filters are hiding the data.
3. Ask the AI: "Can you list all records in the [collection] and show me what data is stored?"

## Design issues

### App looks different on mobile

Use the viewport switcher in the preview to check mobile view regularly. If layout is broken on mobile:

> "The [page] looks broken on mobile. Can you make it responsive — stack elements vertically, make buttons full-width, and ensure everything fits the screen?"

### Inconsistent styling

> "The styling is inconsistent across pages — different fonts, spacing, and colors. Can you standardize the design? Use the same font, color palette, and spacing everywhere."

## Getting help

If you can't resolve an issue:

1. Check this documentation for guidance.
2. Try describing the problem to the AI in detail — it can often diagnose and fix issues.
3. Contact Shogo support through the **Help** menu.

:::tip Take a screenshot
When reporting issues, attaching a screenshot to your chat message or support request makes it much easier to diagnose the problem.
:::
