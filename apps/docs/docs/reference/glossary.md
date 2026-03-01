---
sidebar_position: 1
title: Glossary
slug: /reference/glossary
---

# Glossary

Plain-language definitions of terms you may encounter while using Shogo.

## Shogo concepts

### AI agent
The artificial intelligence system that builds your app based on your chat messages. When you describe what you want, the AI agent writes the code and creates the features.

### Chat panel
The left side of the project editor where you type messages to the AI agent. This is the primary way you build and modify your app.

### Checkpoint
A saved snapshot of your project at a specific point in time. You can create checkpoints manually or they're created automatically when you publish. Checkpoints let you go back to a known good state.

### Collection
A group of related records in your database. For example, a "Customers" collection stores all customer records. Also sometimes called a "table" or "model."

### Credit
The unit of usage in Shogo. Each message you send to the AI costs one credit. Your plan determines how many credits you get per month.

### Dashboard
The main page of your workspace where you can see all your projects, access templates, and manage your account.

### Live preview
The right side of the project editor that shows your running app in real time. Changes appear here as the AI builds them.

### Project
An individual app you're building in Shogo. Each project has its own code, data, and chat history. Projects live inside workspaces.

### Publish / Publishing
The process of deploying your app to a live URL that anyone can visit. Published apps are hosted at `yoursubdomain.shogo.one`.

### Schema
A definition of what your data looks like — what fields a record has and what type each field is. For example, a "Contact" schema might define fields for name (text), email (text), and phone (text). You don't create schemas directly — the AI creates them when you describe your data needs.

### Subdomain
The unique part of your published app's URL. In `my-crm.shogo.one`, "my-crm" is the subdomain. You choose this when you publish.

### Template
A pre-built starter app that you can use as a starting point for your project. Templates include working code, data models, and UI — ready to be customized.

### Viewport
The visible area of your app in the preview. You can switch between desktop, tablet, and mobile viewports to see how your app looks on different screen sizes.

### Workspace
A shared space that contains projects and members. Workspaces have their own billing, credit pool, and team. You can belong to multiple workspaces.

## General technology terms

### API (Application Programming Interface)
A way for different software systems to communicate with each other. The Shogo SDK uses APIs behind the scenes to connect your app to authentication, database, and email services.

### Authentication
The process of verifying a user's identity — typically through login with email and password. Authentication answers the question "who are you?"

### Backend
The behind-the-scenes part of an app that handles data storage, user accounts, and business logic. In Shogo, the backend is managed for you automatically.

### Browser
A program used to access websites, like Chrome, Safari, Firefox, or Edge. Your published Shogo apps run in browsers.

### CRUD
An acronym for Create, Read, Update, Delete — the four basic operations you can perform on data. Most apps are built around CRUD operations.

### Database
A system for storing and organizing data. When your app saves information (like tasks, contacts, or orders), it goes into a database. Shogo uses PostgreSQL databases.

### Deploy / Deployment
The process of making an app available on the internet. In Shogo, this happens when you click "Publish."

### Frontend
The visible part of an app that users interact with — buttons, forms, text, images, and navigation. Everything you see in the preview is the frontend.

### HTTPS
A secure protocol for transferring data on the web. All Shogo apps use HTTPS, meaning data is encrypted between the user's browser and the server.

### OAuth
A method that lets users sign in to your app using their existing accounts on services like Google or GitHub, instead of creating a new username and password.

### PostgreSQL
A popular open-source database system. Shogo uses PostgreSQL to store your app's data. You don't need to know how PostgreSQL works — Shogo manages it for you.

### Responsive design
An approach to building apps that look good and work well on all screen sizes — from phones to tablets to desktop computers.

### SDK (Software Development Kit)
A set of tools and code that developers can use to build apps with specific capabilities. The Shogo SDK lets developers add Shogo-powered authentication, database, and email to their own projects.

### URL
A web address like `https://my-app.shogo.one`. URLs are how people access websites and apps on the internet.

## UI elements

### Button
A clickable element that performs an action when clicked, like "Submit", "Save", or "Sign In."

### Card
A rectangular container used to display related information together — like a product card showing an image, name, and price.

### Dropdown
A menu that appears when you click a button or field, showing a list of options to choose from.

### Form
A collection of input fields where users enter data — like a contact form with fields for name, email, and message.

### Modal / Dialog
A window that pops up in front of the main content, usually to confirm an action or show additional information.

### Navigation bar (Nav bar)
A bar at the top or side of the app containing links to different pages.

### Sidebar
A vertical navigation panel on the left or right side of the page, containing links or tools.

### Table
A grid of rows and columns for displaying data, like a spreadsheet. Each row is a record and each column is a field.

### Toast / Notification
A brief message that appears (usually in a corner of the screen) to inform you of something — like "Saved successfully!" — and disappears after a few seconds.

### Tooltip
A small text popup that appears when you hover over an element, providing additional context or explanation.
