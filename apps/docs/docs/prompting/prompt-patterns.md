---
sidebar_position: 2
title: Prompt Patterns
slug: /prompting/prompt-patterns
---

# Prompt Patterns

These are ready-to-use prompt templates for common tasks. Copy, customize, and use them in your Shogo projects.

## Creating pages

### New page from scratch

> "Create a [Page Name] page with [describe the layout and content]. Include [list of elements]."

**Example:**
> "Create a Settings page with a form for updating user profile information. Include fields for name, email, and bio, with a Save button at the bottom."

### New page based on a design idea

> "Create a page that looks like [description or reference]. Use [colors/style]. The main focus should be [key element]."

**Example:**
> "Create a landing page with a hero section that has a large headline, a short description, and a 'Get Started' button. Use a clean, modern design with lots of white space."

## Adding features

### Add a form

> "Add a form to [page] with fields for [list fields]. When submitted, [describe what should happen]."

**Example:**
> "Add a contact form to the Contact page with fields for name, email, subject, and message. When submitted, show a confirmation message and clear the form."

### Add a list or table

> "Add a [list/table] on [page] that shows [data]. Include columns for [list columns]. Make it [sortable/filterable/searchable]."

**Example:**
> "Add a table on the Customers page that shows all customers. Include columns for name, email, phone, and signup date. Make it sortable by any column and add a search bar at the top."

### Add search and filtering

> "Add a search bar to [page] that filters [items] by [field]. Results should update as I type."

**Example:**
> "Add a search bar to the Products page that filters products by name. Results should update as I type. Also add dropdown filters for category and price range."

### Add navigation

> "Add a [navigation bar/sidebar/tabs] with links to [list pages]."

**Example:**
> "Add a navigation bar at the top with links to Dashboard, Contacts, Projects, and Settings. Highlight the current page. On mobile, show a hamburger menu."

### Add authentication

> "Add user login and registration to my app. Users should be able to [describe the flow]."

**Example:**
> "Add user login and registration. Users should sign up with email and password, then log in. Show the user's name in the top-right corner when logged in. Redirect to the login page if someone tries to access a protected page."

## Modifying existing features

### Change the design

> "Change [element] on [page] to [new design]. Keep everything else the same."

**Example:**
> "Change the background color of the header to dark navy blue and the text to white. Keep the layout and links the same."

### Rearrange layout

> "On [page], move [element A] to [position]. Put [element B] [position relative to A]."

**Example:**
> "On the Dashboard, move the stats cards above the activity table. Put the welcome message at the very top of the page."

### Add to existing feature

> "In the [existing feature] on [page], also add [new capability]."

**Example:**
> "In the customer table on the Contacts page, also add a delete button on each row. Show a confirmation dialog before deleting."

## Working with data

### Create a data model

> "I need to store [type of data] with these fields: [list fields with types]. Each [item] should [describe relationships]."

**Example:**
> "I need to store Projects with these fields: name (text), description (text), start date (date), end date (date), status (active/completed/archived), and owner (text). Each Project should be able to have multiple Tasks."

### Add sample data

> "Add some sample data for [data type]. Include [number] realistic entries."

**Example:**
> "Add 10 sample customers with realistic names, email addresses, phone numbers, and companies."

### Connect data to UI

> "Show [data] on [page] using [display format]. Include [specific fields]."

**Example:**
> "Show all projects on the Projects page using cards. Each card should display the project name, description, status, and a progress bar showing completion percentage."

## Fixing problems

### Report a bug

> "On [page], when I [action], [what happens]. It should [what should happen] instead."

**Example:**
> "On the Booking page, when I click Submit without filling in a date, the form submits anyway. It should show an error message saying 'Please select a date' instead."

### Request a redesign

> "The [element] on [page] doesn't look right. Can you make it [description of desired look]?"

**Example:**
> "The product cards on the Shop page don't look right. Can you make them all the same height, with the image taking up the top half and the details in the bottom half? Add a subtle shadow and rounded corners."

### Ask for help

> "Something isn't working right with [feature]. Can you help me figure out what's wrong?"

**Example:**
> "Something isn't working right with the search on the Contacts page. It worked before but now it doesn't filter anything when I type. Can you help me figure out what's wrong?"

## Pro tips

:::tip Chain your prompts
After the AI completes one request, build on it with follow-up prompts:
1. "Create a product list page."
2. "Add an 'Add Product' button that opens a form."
3. "Add an edit button to each product card."
4. "Add a confirmation before deleting a product."
:::

:::tip Reference what exists
Mention existing pages or features to help the AI understand context:
> "On the Dashboard (the page with the stats cards), add a chart showing monthly revenue below the stats."
:::
