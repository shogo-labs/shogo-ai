---
sidebar_position: 3
title: Common Patterns
slug: /tips-and-tricks/common-patterns
---

# Common Patterns

These are recipes for features that many apps need. Use these prompt patterns as starting points and customize them for your specific use case.

## User authentication

### Basic login and registration

> "Add user authentication to my app. Include a login page with email and password fields, a registration page with name, email, and password, and a sign-out button in the navigation. Protected pages should redirect to the login page if the user isn't signed in."

### Show different content for logged-in users

> "When a user is logged in, show their name and a profile icon in the top-right corner with a dropdown for Settings and Sign Out. When not logged in, show 'Sign In' and 'Sign Up' buttons instead."

## CRUD interfaces (Create, Read, Update, Delete)

### Basic list with add/edit/delete

> "Create a [items] management page with:
> - A table showing all [items] with columns for [field1], [field2], [field3]
> - An 'Add' button that opens a form to create a new [item]
> - An 'Edit' button on each row that opens the form pre-filled with that item's data
> - A 'Delete' button on each row with a confirmation dialog
> - A search bar that filters the table by [field]"

**Example:**
> "Create a Products management page with a table showing all products with columns for name, price, category, and stock. Add an 'Add Product' button, edit and delete buttons on each row, and a search bar that filters by product name."

## Admin panels

### Basic admin dashboard

> "Create an Admin section with:
> - A dashboard showing key stats (total users, total [items], recent activity)
> - A Users page listing all users with name, email, role, and signup date
> - The ability to change a user's role or deactivate their account
> - Only accessible to users with an 'admin' role"

## Search and filtering

### Multi-field search

> "Add a search bar to the [page] that searches across [field1], [field2], and [field3]. Results should update as I type without needing to press Enter."

### Category filters

> "Add filter buttons above the [items] list for [categories]. Clicking a filter shows only items in that category. Add an 'All' button to show everything. The active filter should be visually highlighted."

### Advanced filter panel

> "Add a filter panel with dropdowns for [field1] and [field2], a date range picker for [date field], and a price slider for min/max [number field]. Add a 'Clear Filters' button. Show the number of results."

## Data display

### Cards layout

> "Display [items] as cards in a responsive grid — 3 per row on desktop, 2 on tablet, 1 on mobile. Each card shows [image] at the top, [title] in bold, [description] truncated to 2 lines, and [price/status] at the bottom."

### Tables with sorting

> "Show [items] in a table with sortable columns. Clicking a column header sorts by that column. Click again to reverse the order. Show an arrow indicator on the sorted column."

### Detail pages

> "When clicking on a [item] card/row, navigate to a detail page showing all information about that [item], including [related items] in a list below."

## Forms

### Multi-step form

> "Create a multi-step form for [purpose] with 3 steps:
> 1. Step 1: [fields]
> 2. Step 2: [fields]
> 3. Step 3: Review all entered information
> Show a progress indicator at the top. Add Back and Next buttons. The final step has a Submit button."

### Form with validation

> "Add form validation: [field1] is required, [email field] must be a valid email, [number field] must be between [min] and [max], [password] must be at least 8 characters. Show error messages below each invalid field in red."

## Navigation patterns

### Sidebar navigation

> "Add a sidebar navigation on the left side with links to [page1], [page2], [page3], and [page4]. Each link should have an icon. Highlight the current page. On mobile, collapse the sidebar into a hamburger menu."

### Tabs

> "Add tabs at the top of the [page] page with: [Tab1], [Tab2], [Tab3]. Each tab shows different content. The active tab should be highlighted. Keep the tab state when switching between them."

## Responsive design

### Mobile-friendly layout

> "Make sure [page] works well on mobile devices. Stack columns vertically on small screens, make buttons full-width, and ensure text is readable. Tables should scroll horizontally if they don't fit."

## Notifications and feedback

### Success/error messages

> "After submitting the form, show a green success message at the top of the page that says '[success text]' and disappears after 5 seconds. If there's an error, show a red error message instead."

### Empty states

> "When there are no [items], show a friendly empty state with an illustration, a message saying 'No [items] yet', and a button to create the first one."
