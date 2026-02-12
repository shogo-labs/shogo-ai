---
sidebar_position: 3
title: Advanced Prompting
slug: /prompting/advanced-prompting
---

# Advanced Prompting

Once you're comfortable with the basics, these techniques will help you build faster and get more precise results.

## Iterative refinement

Building with AI is a conversation, not a one-shot request. The best results come from an iterative approach:

1. **Start broad** — Describe the overall feature or page you want.
2. **Review the result** — Look at the preview carefully.
3. **Refine in follow-ups** — Ask for specific adjustments.

**Example sequence:**

> "Create a pricing page with three plan cards: Free, Pro, and Business."

*Review: The layout is good but the cards need more detail.*

> "Add a list of features to each card. Free should have 5 features, Pro should have 10, and Business should have 15. Add a 'Most Popular' badge to the Pro card."

*Review: Looking better, but the design needs work.*

> "Make the Pro card slightly larger than the others and give it a blue border. Add a gradient background to the header of each card."

Each step builds on the last, giving you fine-grained control over the result.

## Setting constraints

Tell the AI what *not* to do, as well as what to do. This prevents unintended side effects.

> "Add a footer to every page with copyright info and social links. Don't change the header or navigation — those are working correctly."

> "Update the color scheme to use green instead of blue. Only change the accent colors — keep the text colors and background the same."

> "Add form validation to the signup page. Don't modify the login page."

## Describing complex layouts

For detailed layouts, describe the structure in sections:

> "Create a Dashboard page with this layout:
> - **Top bar**: Welcome message with the user's name on the left, and a notification bell and profile icon on the right.
> - **Stats row**: Four stat cards showing Total Orders, Revenue, Customers, and Products. Each card has a number and a small trend indicator.
> - **Main area**: Two columns. Left column (wider) has a line chart showing weekly revenue. Right column has a list of recent orders with customer name, amount, and status."

The AI handles multi-section layouts well when you describe each section clearly.

## Using roles and scenarios

Describe who uses the feature and in what context:

> "As an admin, I want to see a list of all users with the ability to edit or deactivate accounts. Regular users should not see this page — redirect them to the dashboard if they try to access it."

> "When a customer fills out the contact form, they should see a thank-you message. The admin should see the submission appear in the Admin Dashboard."

## Asking the AI to explain

You can ask the AI to describe what it did or to help you understand something:

> "What changes did you just make? Can you explain them?"

> "I want to add a notification system. Can you walk me through the different ways to approach this before we start building?"

> "What data tables does my app have right now? List them with their fields."

This is especially useful when you're picking up a project after some time away.

## Providing reference and context

### Reference existing parts of your app

> "Make the Settings page follow the same layout as the Dashboard — same header, same sidebar, same card style."

> "The product cards on the Shop page look great. Use the same card style for the Team Members section on the About page."

### Describe the user experience

> "When a new user signs up, the flow should be: Registration form → Welcome screen explaining the app → Redirect to the Dashboard. Each step should feel smooth and guided."

## Multi-step features

For complex features, lay out the plan first:

> "I want to build an invoice system. Here's what I need:
> 1. A list of all invoices with filters for status (Draft, Sent, Paid, Overdue)
> 2. A form to create new invoices with client name, line items, amounts, and due date
> 3. An invoice detail page that shows all the info and can be printed
> 4. The ability to mark an invoice as Sent or Paid
>
> Let's start with step 1."

Then work through each step in order, verifying as you go.

## Credit-efficient prompting

Since each message costs a credit, make your prompts count:

- **Combine related small changes** — "Change the header to blue, center the logo, and increase the font size of the navigation links" is better than three separate messages.
- **Be clear the first time** — Spending a moment thinking about your prompt saves credits on back-and-forth corrections.
- **Use follow-ups wisely** — "Also add..." is often more efficient than describing the whole feature again.

## Summary

| Technique | When to use |
|-----------|-------------|
| Iterative refinement | Building any feature — start broad, then refine |
| Setting constraints | When you want changes to be scoped to specific areas |
| Describing complex layouts | Multi-section pages with specific structure |
| Using roles and scenarios | Apps with different user types |
| Asking for explanations | Understanding what was built or planning next steps |
| Multi-step features | Large features that need to be built incrementally |
