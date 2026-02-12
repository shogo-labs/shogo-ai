---
sidebar_position: 2
title: From Idea to App
slug: /tips-and-tricks/from-idea-to-app
---

# From Idea to App

This walkthrough takes you through the full process of building a real app with Shogo — from initial idea to published product. We'll build a **Client Project Tracker** as our example.

## Phase 1: Define your app

Before opening Shogo, answer these questions:

**What is it?**
A project tracker where freelancers manage client projects, track tasks, and log time.

**Who uses it?**
Freelancers and small agencies who juggle multiple clients.

**Key features:**
1. List of clients with contact info
2. Projects linked to each client
3. Tasks within each project
4. Time logging for each task
5. Dashboard with overview stats

**Data types:**
- Clients (name, email, company, phone)
- Projects (name, description, status, client, deadline)
- Tasks (title, status, project, assigned to, due date)
- Time entries (task, duration, date, notes)

## Phase 2: Start the project

### Option A: Start from a template

The **Kanban** or **Todo App** template would be a good starting point. You can reshape it into a project tracker.

### Option B: Start from scratch

For this walkthrough, we'll start from scratch to show the full process.

**First prompt:**
> "I'm building a project tracker for freelancers. It should have a Dashboard, Clients page, Projects page, and a Task board. Start by creating the navigation with links to these four pages and a clean, professional design using blue and gray tones."

## Phase 3: Build the foundation

### Add the client management

> "Create a Clients page with a list of clients. Each client should have a name, email, company, and phone number. Add an 'Add Client' button that opens a form to create a new client."

*Test: Add 2-3 sample clients and verify they appear in the list.*

### Add project tracking

> "Create a Projects page. Each project has a name, description, status (Active, On Hold, Completed), deadline, and is linked to a client. Show projects in a card layout. Add a form to create new projects with a dropdown to select the client."

*Test: Create projects linked to your clients. Verify the client name shows on each project card.*

### Add task management

> "On each Project, add a task list. Tasks have a title, status (To Do, In Progress, Done), due date, and priority (Low, Medium, High). Show tasks in a simple list grouped by status. Add a quick-add form at the top."

*Test: Navigate to a project and add tasks. Move tasks between statuses.*

## Phase 4: Add the dashboard

> "Create a Dashboard page that shows: total clients, active projects, overdue tasks, and total hours logged this week. Use stat cards at the top. Below that, add a list of recent activity and a list of upcoming deadlines."

*Test: Verify the stats reflect your actual data.*

## Phase 5: Polish and refine

### Improve the design

> "Add a sidebar navigation instead of the top nav. Put the logo at the top of the sidebar, then the navigation links with icons. Make the sidebar dark gray with white text."

### Add search

> "Add a search bar at the top of the Clients page that filters clients by name or company as I type."

### Add time tracking

> "Add a Time Log feature. On each task, add a 'Log Time' button. The form should have hours, date, and notes fields. Show total hours logged on each task and on the project overview."

### Mobile responsiveness

> "Make sure the app works well on mobile. The sidebar should collapse into a hamburger menu on small screens. Tables should scroll horizontally if they're too wide."

## Phase 6: Test thoroughly

Before publishing, go through the complete user journey:

1. Create a new client
2. Create a project for that client
3. Add tasks to the project
4. Log time on a task
5. Check the dashboard stats
6. Search for a client
7. Test on mobile viewport

Fix any issues you find through chat.

## Phase 7: Publish

> See [Publishing Your App](../features/publishing) for the full publishing guide.

1. Click **Publish**.
2. Choose a subdomain (e.g., `mytracker.shogo.one`).
3. Set access control.
4. Click **Publish**.

Your app is live! Share the URL with your first users.

## Key takeaways

1. **Plan before you build** — 10 minutes of planning saves hours of rework.
2. **Build in layers** — Foundation first, then features, then polish.
3. **Test after each step** — Don't wait until the end to check if things work.
4. **Iterate through conversation** — The AI remembers context, so build on previous changes.
5. **Publish early** — You can always update. Getting a live URL motivates further refinement.
