---
sidebar_position: 6
title: Expense Tracker
slug: /templates/expense-tracker
---

# Expense Tracker Template

Record and categorize personal or business expenses, set budgets, and see where your money goes with clear breakdowns and summaries.

## What's included

- **Expense list** — Record all expenses with amount, category, and date
- **Categories** — Organize expenses (Food, Transport, Utilities, etc.)
- **Budget tracking** — Set monthly budgets and track spending against them
- **Payment methods** — Track how you paid (cash, card, transfer)
- **Summary views** — See spending breakdowns by category and time period

## Data model

**Expense**
| Field | Type | Description |
|-------|------|-------------|
| Description | Text | What the expense was for |
| Amount | Number | How much was spent |
| Category | Reference | Expense category |
| Date | Date | When the expense occurred |
| Payment method | Reference | How it was paid |
| Notes | Text | Additional details |

**Category**
| Field | Type | Description |
|-------|------|-------------|
| Name | Text | Category name (e.g., Food, Transport) |
| Budget | Number | Monthly budget for this category |
| Icon | Text | Visual identifier |

**Payment Method**
| Field | Type | Description |
|-------|------|-------------|
| Name | Text | Method name (e.g., Cash, Credit Card) |
| Type | Selection | Cash, Card, Bank Transfer, Digital |

## Getting started

1. Go to **Templates** and select **Expense Tracker**.
2. Click **Use Template** to create your project.
3. Add some expenses and explore the budget tracking features.
4. Customize it for your financial tracking needs.

## Customization ideas

> "Add charts showing monthly spending trends over the last 6 months."

> "Add a pie chart breaking down spending by category."

> "Add recurring expenses — like rent or subscriptions — that auto-repeat each month."

> "Add the ability to attach receipt photos to each expense."

> "Create a yearly summary view with month-by-month comparisons."

## Who this is for

- Individuals tracking personal spending
- Freelancers managing business expenses
- Small businesses monitoring costs
- Anyone who wants to understand their spending habits
