---
sidebar_position: 4
title: Troubleshooting with Prompts
slug: /prompting/troubleshooting-with-prompts
---

# Troubleshooting with Prompts

Sometimes the AI doesn't get it right the first time, or things break as your app grows. This guide helps you get back on track.

## When the result isn't what you expected

### Be more specific about what's wrong

Instead of:
> "This doesn't look right. Fix it."

Try:
> "The contact form is showing the fields in a single row, but I want them stacked vertically. Each field should be on its own line with a label above it."

The more precisely you describe the gap between what you see and what you want, the better the fix.

### Show, don't just tell

Attach a screenshot of the current state and describe what's different from your expectations:

> "Here's what the page looks like now [attach screenshot]. The sidebar is overlapping the main content on mobile. I want the sidebar to collapse into a hamburger menu on screens smaller than tablet size."

## When something breaks

### Describe the problem clearly

Use this format:
> "On [which page], when I [what action I take], [what happens]. I expected [what should happen]."

**Example:**
> "On the Checkout page, when I click 'Place Order' with items in the cart, nothing happens. I expected it to show an order confirmation screen and clear the cart."

### Ask the AI to investigate

> "The search feature on the Products page stopped working. It was working before I asked you to add the category filter. Can you investigate what happened?"

> "Something broke on the Dashboard — the stats cards are showing 'undefined' instead of numbers. Can you check what's wrong?"

### Revert if needed

If the AI's changes made things worse, don't keep layering fixes. Revert to a working version first:

1. Open the **History** panel.
2. Find the last version where things worked.
3. Revert to that version.
4. Try a different approach to your request.

See [History and Checkpoints](../features/history-and-checkpoints) for details on reverting.

## When the AI gets stuck in a loop

Sometimes the AI might repeatedly try to fix something without success. Signs of this:

- The same error keeps appearing after multiple fix attempts
- Changes seem to undo each other
- The preview keeps breaking in different ways

**What to do:**

1. **Stop and revert** — Go back to the last working version.
2. **Describe the goal differently** — Use different words or break the task into smaller pieces.
3. **Simplify the request** — Instead of asking for the full feature, ask for a simpler version first.

**Example:**

Instead of:
> "Add a complex multi-step wizard form with validation, file uploads, and dynamic fields."

Try:
> "Add a simple form with three steps. Step 1: Name and email. Step 2: Choose a plan. Step 3: Confirm and submit. Let's start with just the basic step navigation."

Then add complexity incrementally.

## Common issues and how to fix them

### Layout problems

> "The layout is broken — elements are overlapping. Can you fix the spacing and make sure everything has proper padding and margins?"

> "The page looks fine on desktop but is broken on mobile. Can you make it responsive so it stacks vertically on small screens?"

### Missing data

> "The table is showing empty. Can you check if the data is being loaded correctly? Also, add some sample data so I can see how it should look."

### Buttons that don't work

> "The 'Save' button on the profile page doesn't do anything when I click it. Can you connect it so it actually saves the form data?"

### Styling inconsistencies

> "The cards on the Products page have different font sizes and spacing. Can you make them all consistent — same font, same padding, same height?"

## The "fresh start" approach

If a feature is really not working, sometimes the best approach is to ask the AI to start that specific part over:

> "The booking calendar feature isn't working well. Can you remove it completely and rebuild it from scratch? Here's what I need: [clear description]."

This is better than trying to patch broken code repeatedly.

## Asking for help

Remember, you can always ask the AI for guidance:

> "I'm not sure what's going wrong. Can you look at the current state of the app and tell me if you see any issues?"

> "I've tried to fix this three times. Can you suggest a different approach?"

> "Before making any changes, can you explain what might be causing this problem?"

## Prevention tips

:::tip Build incrementally
The #1 way to avoid problems is to build one feature at a time and test it before moving on. Most issues come from trying to do too much at once.
:::

:::tip Test as you go
After each change, interact with the preview. Click buttons, fill in forms, navigate between pages. Catch issues early when they're easy to fix.
:::

:::tip Save before experiments
Before trying something ambitious, make sure you have a recent checkpoint or know how to revert. See [History and Checkpoints](../features/history-and-checkpoints).
:::
