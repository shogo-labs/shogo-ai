---
sidebar_position: 4
title: Database
slug: /features/database
---

# Database

Every Shogo app can store data — like a list of tasks, customer records, product inventory, or booking information. The database panel lets you view and understand this data.

## What is a database?

Think of a database as a collection of organized spreadsheets. Each "spreadsheet" (called a **table** or **collection**) holds one type of information:

- A **Contacts** table might store names, emails, and phone numbers
- A **Products** table might store names, prices, and descriptions
- A **Tasks** table might store titles, due dates, and completion status

When you ask the AI to add features that involve storing information, it automatically creates and manages these tables for you.

## Viewing your data

To see your app's data:

1. Open your project.
2. Click the **Database** tab at the top of the right panel.
3. You'll see a list of your data tables (collections).
4. Click on any table to see its records displayed in a table format.

## How data is created

You don't need to set up the database yourself. When you chat with the AI and describe features that need to store information, the AI:

1. **Creates the data structure** (what fields each record has)
2. **Builds the interface** (forms to add data, tables to display it)
3. **Connects everything** (so your app reads and writes data automatically)

**Example:**

> "Create a contact list with fields for name, email, phone number, and company."

The AI will create a Contacts table with those fields, build a form to add new contacts, and display them in a list or table view.

## Data models (schemas)

Behind the scenes, your data is organized using **schemas** — definitions of what each type of data looks like. For example, a Task schema might define:

- **Title** (text)
- **Description** (text)
- **Due date** (date)
- **Completed** (yes/no)
- **Assigned to** (a reference to a user)

You don't need to create or edit schemas directly — the AI handles this through chat. But understanding that they exist helps when you're describing complex data to the AI.

:::tip Describe relationships
If your data types are connected (like "each Project has many Tasks"), tell the AI about these relationships. It will set up the connections automatically.

> "Each project can have many tasks. Each task belongs to one project."
:::

## Published app database

When you publish your app, Shogo automatically provisions a PostgreSQL database for your live app. This means:

- Your published app has its own separate, persistent database
- Data created by users of your published app is stored there
- The database is managed for you — no setup or maintenance needed

## FAQ

**Can I manually add data to the database?**
The database panel is primarily for viewing data. To add or modify data, use the chat to ask the AI to create forms or data management interfaces, or ask it to seed sample data.

**Is my data safe?**
Yes. Your data is stored securely and is accessible only to your app and your workspace.

**Can I export my data?**
You can view all your data in the database panel. For export functionality, ask the AI to add an export feature to your app (like a "Download as CSV" button).

**What happens to my data if I unpublish?**
Unpublishing removes your app from its public URL, but your database and data are preserved. If you republish, your data will still be there.
