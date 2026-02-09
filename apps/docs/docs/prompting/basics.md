---
sidebar_position: 1
title: Prompting Basics
slug: /prompting/basics
---

# Prompting Basics

The quality of what Shogo builds depends largely on the quality of your messages. This guide teaches you how to write effective prompts that get the results you want.

## The golden rule: be specific

The AI responds to what you tell it. Vague prompts produce vague results. Specific prompts produce specific results.

**Vague:**
> "Make a page."

**Specific:**
> "Create a Dashboard page with a welcome message at the top, three stat cards showing Total Users, Active Projects, and Revenue, and a table below showing recent activity."

You don't need to be technical — just be descriptive. Imagine you're explaining what you want to a colleague who can't see your screen.

## Start with the big picture

When beginning a new project or feature, start by describing the overall goal before diving into details.

> "I'm building a booking system for a hair salon. Customers should be able to see available time slots, pick a service (haircut, coloring, styling), choose a date and time, and book an appointment. The salon owner should have an admin view where they can see all bookings."

This gives the AI context that helps it make better decisions as you build out each piece.

## Break complex work into steps

Don't try to build everything in one message. Break large features into a sequence of smaller requests:

1. "Create a Bookings page with a calendar view."
2. "Add a list of services: Haircut ($30), Coloring ($60), Styling ($45)."
3. "Add a booking form where customers select a service, date, and time."
4. "Create an Admin page that shows all bookings in a table."
5. "Add a status column to bookings: Pending, Confirmed, Completed, Cancelled."

Each step is easier for the AI to handle correctly, and you can verify each one before moving on.

## Describe the result, not the process

You don't need to tell the AI *how* to build something. Just describe *what* you want to see.

**Process-focused (don't do this):**
> "Create a React component using useState to track the selected tab, then map over an array of tab objects and render them with conditional styling."

**Result-focused (do this):**
> "Add a tabbed navigation with three tabs: Overview, Details, and Reviews. The active tab should be highlighted. Clicking a tab shows different content."

## Use natural language

Write like you're talking to a person. Don't try to write in code or use programming terminology.

**Natural:**
> "When someone clicks the Submit button, show a success message that says 'Your request has been submitted!' and clear the form."

**Overly technical:**
> "Add an onClick handler to the submit button that sets a state variable to true, conditionally renders a success toast, and resets the form state."

Both will work, but the natural version is clearer and easier to write.

## Include visual details

When you care about how something looks, say so:

> "Make the header dark blue with white text. Use a large, bold font for the page title. Add some padding so the content doesn't touch the edges."

> "Display the products in a grid — three cards per row on desktop, two on tablet, and one on mobile. Each card should have a shadow and rounded corners."

## Ask the AI to explain or suggest

You can ask questions too — not just give instructions:

> "What's the best way to organize the navigation for this app?"

> "Can you suggest a color scheme that looks professional?"

> "I'm not sure how to structure the data for this feature. Can you help me think through it?"

## Summary

| Do | Don't |
|---|---|
| Be specific and descriptive | Use vague instructions like "make it better" |
| Break complex work into steps | Try to build everything at once |
| Describe what you want to see | Tell the AI how to code it |
| Use natural language | Use programming jargon |
| Include visual and layout details | Assume the AI knows your preferences |
| Ask questions when unsure | Stay stuck without asking for help |
