---
sidebar_position: 1
title: Best Practices
slug: /tips-and-tricks/best-practices
---

# Best Practices

These tips will help you get the best results from Shogo, save credits, and build apps more effectively.

## 1. Plan before you prompt

Before opening Shogo, spend a few minutes thinking about what you want to build:

- **What is the app for?** — "A booking system for my yoga studio."
- **Who will use it?** — "My clients and my front-desk staff."
- **What are the key features?** — "Schedule view, booking form, admin dashboard."
- **What data needs to be stored?** — "Classes, bookings, clients, instructors."

Even rough notes on paper will make your prompts significantly better.

## 2. Start with a template

If a template is close to what you need, start there instead of from scratch. It's faster to customize a working app than to build one from nothing.

Browse the [Templates](../templates/) to see what's available. You can always change everything about a template after starting.

## 3. Build one feature at a time

The most common mistake is trying to build too much at once. Instead:

1. Get one feature working and verified.
2. Move to the next feature.
3. Repeat.

**Example sequence for a booking app:**
1. "Create a list of yoga classes with name, instructor, time, and capacity."
2. "Add a booking form where clients enter their name and email and select a class."
3. "Create an admin page that shows all bookings."
4. "Add the ability to cancel a booking."
5. "Add a calendar view showing classes by day."

Each step is manageable and testable.

## 4. Test in the preview after every change

After each AI response, interact with the preview:

- Click all buttons to make sure they work
- Fill in forms and submit them
- Navigate between pages
- Check different viewport sizes (desktop, tablet, mobile)

Catching issues early saves credits and prevents compounding problems.

## 5. Use checkpoints wisely

Before making a big change, make sure you have a checkpoint. This way, if something goes wrong, you can always go back.

Good times to checkpoint:
- After completing a major feature
- Before a significant redesign
- Before adding authentication or complex data logic

See [History & Checkpoints](../features/history-and-checkpoints).

## 6. Be specific in your prompts

Vague prompts lead to vague results. Compare:

**Vague:** "Make it look better."

**Specific:** "Change the header to use a dark navy background with white text. Increase the padding to give it more breathing room. Make the logo larger."

See the [Prompting Guide](../prompting/basics) for more techniques.

## 7. Save credits with combined requests

If you have several small related changes, combine them into one message:

**Instead of three messages:**
> 1. "Change the header color to blue."
> 2. "Make the header text white."
> 3. "Add padding to the header."

**Send one message:**
> "Change the header to have a blue background, white text, and more padding."

This uses one credit instead of three.

## 8. Revert early, not late

If the AI's change broke something, revert immediately. Don't layer more changes on top of a broken state — it makes things harder to fix.

## 9. Describe relationships in your data

When your app has connected data, tell the AI explicitly:

> "Each instructor teaches multiple classes. Each class can have many bookings. Each booking belongs to one client and one class."

This helps the AI set up proper data structures and navigation.

## 10. Don't be afraid to start over on a feature

If a feature isn't working after several attempts, it's often faster to:

1. Revert to before the feature
2. Describe it differently
3. Build it in smaller steps

See [Troubleshooting with Prompts](../prompting/troubleshooting-with-prompts) for more strategies.
