---
sidebar_position: 3
title: CRM
slug: /templates/crm
---

# CRM Template

A customer relationship management tool for tracking contacts, companies, deals, and interactions with your customers or clients.

## What's included

- **Contacts** — Store and manage contact information (name, email, phone, company)
- **Companies** — Track organizations and link contacts to companies
- **Deals** — Manage sales opportunities with stages and values
- **Activity tracking** — Log interactions like calls, emails, and meetings
- **Dashboard** — Overview of your pipeline and key metrics

## Data model

The template includes these data types:

**Contact**
| Field | Type | Description |
|-------|------|-------------|
| Name | Text | Contact's full name |
| Email | Text | Email address |
| Phone | Text | Phone number |
| Company | Reference | Linked company |
| Status | Selection | Lead, Active, Inactive |

**Company**
| Field | Type | Description |
|-------|------|-------------|
| Name | Text | Company name |
| Industry | Text | Business sector |
| Website | Text | Company URL |
| Size | Selection | Small, Medium, Large |

**Deal**
| Field | Type | Description |
|-------|------|-------------|
| Title | Text | Deal name |
| Value | Number | Deal amount |
| Stage | Selection | Prospect, Qualified, Proposal, Closed Won, Closed Lost |
| Contact | Reference | Associated contact |
| Close date | Date | Expected close date |

## Getting started

1. Go to **Templates** and select **CRM**.
2. Click **Use Template** to create your project.
3. Explore the app — add contacts, create deals, and browse the dashboard.
4. Customize it to fit your sales process.

## Customization ideas

> "Add a kanban view for deals where I can drag them between stages."

> "Add email tracking — log when emails are sent and opened."

> "Create a reporting page with charts showing monthly revenue, deal stages, and top customers."

> "Add tags to contacts so I can categorize them (VIP, Partner, Vendor)."

> "Add a notes section to each contact where I can log meeting notes and follow-ups."

## Who this is for

- Small businesses tracking customer relationships
- Sales teams managing their pipeline
- Freelancers tracking clients and projects
- Agencies managing client accounts
