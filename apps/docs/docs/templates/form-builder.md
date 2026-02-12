---
sidebar_position: 8
title: Form Builder
slug: /templates/form-builder
---

# Form Builder Template

Create and manage custom forms with various field types. Collect responses from users and view all submissions in one place.

## What's included

- **Form creation** — Build forms with different field types
- **Field types** — Text, email, number, dropdown, checkbox, date, and more
- **Form sharing** — Share forms with a link
- **Submissions view** — See all responses in a table format
- **Form management** — Create multiple forms and manage them from a dashboard

## Data model

**Form**
| Field | Type | Description |
|-------|------|-------------|
| Title | Text | Form name |
| Description | Text | Form description/instructions |
| Fields | Collection | List of form fields |
| Status | Selection | Draft, Active, Closed |

**Submission**
| Field | Type | Description |
|-------|------|-------------|
| Form | Reference | Which form was submitted |
| Responses | Data | Submitted field values |
| Submitted at | Date | When it was submitted |
| Submitted by | Text | Who submitted it |

## Getting started

1. Go to **Templates** and select **Form Builder**.
2. Click **Use Template** to create your project.
3. Create a sample form, fill it in, and see the submission appear.
4. Customize the form builder for your needs.

## Customization ideas

> "Add a 'Thank you' page that shows after a form is submitted."

> "Add conditional fields — show or hide fields based on previous answers."

> "Add the ability to export submissions as a CSV file."

> "Add email notifications when a new submission comes in."

> "Add form templates — pre-built forms for common use cases like contact forms, surveys, and registrations."

## Who this is for

- Businesses collecting customer information
- Event organizers managing registrations
- HR teams creating application forms
- Researchers conducting surveys
- Anyone who needs to collect structured data from people
