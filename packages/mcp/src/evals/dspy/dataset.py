"""
Training and Test Dataset for DSPy Optimization

This module converts our TypeScript eval test cases into DSPy Examples
for use in optimization.
"""

import dspy
from typing import List, Tuple


# Direct match examples - high confidence, clear intent
DIRECT_MATCH_EXAMPLES = [
    # Todo app variations
    ("Build me a todo app", "todo-app", "Direct keyword match: 'todo'"),
    ("Create a todo list", "todo-app", "Direct keyword match: 'todo list'"),
    ("I need a task tracker", "todo-app", "Semantic match: 'task tracker' → tasks → todo"),
    ("Make a checklist app", "todo-app", "Direct keyword match: 'checklist'"),
    ("Simple task management", "todo-app", "Semantic match: 'task management'"),
    
    # Expense tracker variations
    ("Build an expense tracker", "expense-tracker", "Direct keyword match: 'expense tracker'"),
    ("Create a budget app", "expense-tracker", "Semantic match: 'budget' → finance → expense"),
    ("Track my spending", "expense-tracker", "Direct keyword match: 'spending'"),
    ("Personal finance manager", "expense-tracker", "Semantic match: 'personal finance'"),
    ("Money tracking application", "expense-tracker", "Direct keyword match: 'money tracking'"),
    
    # CRM variations
    ("Build a CRM", "crm", "Direct keyword match: 'CRM'"),
    ("Customer relationship management", "crm", "Expanded form of CRM"),
    ("Sales pipeline app", "crm", "Semantic match: 'sales pipeline' → CRM"),
    ("Lead tracking system", "crm", "Semantic match: 'lead tracking' → sales → CRM"),
    ("Customer database", "crm", "Semantic match: 'customer database' → CRM"),
    ("I need to track my clients", "crm", "Semantic match: 'clients' → customers → CRM"),
    
    # Inventory variations
    ("Build an inventory system", "inventory", "Direct keyword match: 'inventory'"),
    ("Stock management app", "inventory", "Direct keyword match: 'stock management'"),
    ("Product tracking", "inventory", "Semantic match: 'product tracking' → inventory"),
    ("Warehouse management", "inventory", "Direct keyword match: 'warehouse'"),
    ("Track what's in stock", "inventory", "Semantic match: 'in stock' → inventory"),
    
    # Kanban variations
    ("Build a kanban board", "kanban", "Direct keyword match: 'kanban'"),
    ("Project board with cards", "kanban", "Semantic match: 'board with cards' → kanban"),
    ("Drag and drop task board", "kanban", "Key feature: 'drag and drop' → kanban"),
    ("Agile project tracker", "kanban", "Semantic match: 'agile' → kanban methodology"),
    
    # AI Chat variations
    ("Build an AI chatbot", "ai-chat", "Direct keyword match: 'AI chatbot'"),
    ("Create a chat assistant", "ai-chat", "Semantic match: 'chat assistant'"),
    ("Conversational AI app", "ai-chat", "Direct keyword match: 'conversational AI'"),
    ("Build something I can talk to", "ai-chat", "Semantic match: conversational interface"),
    
    # Form builder variations
    ("Build a form builder", "form-builder", "Direct keyword match: 'form builder'"),
    ("Create dynamic forms", "form-builder", "Semantic match: 'dynamic forms'"),
    ("Survey creation tool", "form-builder", "Semantic match: 'survey creation'"),
    
    # Feedback form variations
    ("Build a feedback form", "feedback-form", "Direct keyword match: 'feedback form'"),
    ("User feedback collection", "feedback-form", "Semantic match: 'feedback collection'"),
    ("Rating system", "feedback-form", "Semantic match: 'rating' → feedback"),
    
    # Booking app variations
    ("Build a booking system", "booking-app", "Direct keyword match: 'booking'"),
    ("Appointment scheduler", "booking-app", "Direct keyword match: 'appointment'"),
    ("Reservation app", "booking-app", "Direct keyword match: 'reservation'"),
    ("Schedule appointments", "booking-app", "Direct keyword match: 'schedule appointments'"),
]


# Ambiguous examples - should ask for clarification
AMBIGUOUS_EXAMPLES = [
    ("Build something for my team", "clarify", "Ambiguous: 'team' could be many things"),
    ("I need to track things", "clarify", "Too vague: what kind of things?"),
    ("Build a business app", "clarify", "Multiple templates serve business needs"),
    ("Help me manage stuff", "clarify", "Completely ambiguous request"),
    ("App for my work", "clarify", "Work could mean tasks, projects, customers, etc."),
    ("Make something useful", "clarify", "No domain indicated"),
    ("Need an app", "clarify", "Zero context provided"),
    ("Can you help me build something?", "clarify", "No specific requirement"),
]


# No match examples - should acknowledge limitation
NO_MATCH_EXAMPLES = [
    ("Build a recipe manager", "none", "No recipe-specific template exists"),
    ("Create a game", "none", "Games are outside template scope"),
    ("Build a music streaming app", "none", "Music streaming not in templates"),
    ("Machine learning dashboard", "none", "ML infrastructure not in templates"),
    ("Social media platform", "none", "No social media template"),
    ("Build a photo editing app", "none", "Image editing not in templates"),
    ("Create a video player", "none", "Media playback not supported"),
    ("E-commerce store", "none", "Full e-commerce with cart/checkout not in templates"),
    ("Build a calendar app", "none", "Calendar not directly available - booking is for appointments"),
    ("Build a notes app with markdown", "none", "Rich text notes not in templates"),
]


# Edge cases - competing templates (HARD)
EDGE_CASE_EXAMPLES = [
    # Todo vs Kanban - nuanced differences
    ("Track tasks for my project", "todo-app", "Simple task tracking → todo (not kanban)"),
    ("Visual task board with columns", "kanban", "Visual + columns → kanban"),
    ("I need to organize tasks into categories", "todo-app", "Categories (filters) → todo, not columns"),
    ("Tasks with swimlanes", "kanban", "Swimlanes = columns → kanban"),
    ("Prioritize my daily tasks", "todo-app", "Daily/personal tasks → todo"),
    ("Team sprint planning board", "kanban", "Sprint + board + team → kanban"),
    
    # Expense vs Inventory - subtle differences
    ("Track spending on supplies", "expense-tracker", "Spending is the action → expense"),
    ("Track supply levels", "inventory", "Levels/quantities → inventory"),
    ("Monitor how much I spent on inventory", "expense-tracker", "Spent/spending = expense tracking"),
    ("Track how many items are left", "inventory", "Quantity remaining → inventory"),
    ("Budget for office supplies", "expense-tracker", "Budget = financial → expense"),
    ("Manage product stock", "inventory", "Stock = inventory"),
    
    # CRM vs Booking - client context matters
    ("Manage client appointments", "booking-app", "Appointments → booking (more specific)"),
    ("Track client relationships", "crm", "Relationships → CRM"),
    ("Schedule meetings with clients", "booking-app", "Schedule/meetings → booking"),
    ("Track sales opportunities with leads", "crm", "Sales pipeline → CRM"),
    ("Client contact database", "crm", "Contact database → CRM"),
    ("Book time slots for clients", "booking-app", "Time slots → booking"),
    
    # Form builder vs Feedback - specificity
    ("Collect user feedback", "feedback-form", "Feedback → more specific template"),
    ("Build custom forms", "form-builder", "Custom/dynamic → form builder"),
    ("Create a satisfaction survey", "feedback-form", "Satisfaction/ratings → feedback"),
    ("Build a questionnaire wizard", "form-builder", "Wizard/dynamic → form builder"),
    ("Get product reviews", "feedback-form", "Reviews → feedback"),
    ("Create registration forms", "form-builder", "Registration = custom form"),
    
    # AI Chat vs other templates
    ("Build a help desk bot", "ai-chat", "Bot = conversational AI"),
    ("FAQ chatbot", "ai-chat", "Chatbot → ai-chat"),
    ("Customer support assistant", "ai-chat", "Assistant = AI → ai-chat (not CRM)"),
]


# HARD: Misleading language - sounds like one thing, means another
MISLEADING_EXAMPLES = [
    # "Tracking" is overloaded
    ("Track my fitness", "none", "Fitness tracking not in templates"),
    ("Track packages", "none", "Shipping/delivery not in templates"),
    ("Track my habits", "todo-app", "Habit tracking ≈ recurring tasks → todo"),
    
    # "Board" doesn't always mean kanban
    ("Message board", "none", "Forum/discussion not in templates"),
    ("Dashboard for metrics", "none", "Analytics dashboard not in templates"),
    ("Scoreboard app", "none", "Scores/games not in templates"),
    
    # "Form" context matters
    ("Tax forms", "none", "Tax filing not in templates"),
    ("Application form for jobs", "form-builder", "Job application = custom form"),
    ("Contact form for my website", "feedback-form", "Simple contact = feedback variant"),
    
    # "Manage" is extremely overloaded
    ("Manage my passwords", "none", "Password management not in templates"),
    ("Manage employees", "crm", "Employee database ≈ CRM (people management)"),
    ("Manage files", "none", "File management not in templates"),
    ("Manage my schedule", "booking-app", "Schedule = appointments → booking"),
    
    # "App" with misleading context
    ("Weather app", "none", "Weather data not in templates"),
    ("Calculator app", "none", "Utility apps not in templates"),
    ("Reminder app", "todo-app", "Reminders ≈ tasks → todo"),
]


# HARD: Negative/exclusion tests - explicitly NOT wanting something
NEGATIVE_EXAMPLES = [
    ("I want to track tasks but not as a kanban", "todo-app", "Explicit exclusion of kanban"),
    ("Budget app, not for inventory", "expense-tracker", "Explicitly not inventory"),
    ("Something for customers, but not for booking appointments", "crm", "CRM without booking"),
    ("Form but not for feedback", "form-builder", "Form builder, not feedback form"),
    ("Chat without AI", "none", "Non-AI chat not in templates"),
]


# HARD: Compound/multi-feature requests
COMPOUND_EXAMPLES = [
    ("Todo list with expense tracking", "clarify", "Two templates - need to choose one"),
    ("CRM with appointment booking", "clarify", "CRM + Booking - need clarification"),
    ("Kanban board with chat", "kanban", "Primary feature is kanban, chat is secondary"),
    ("Inventory with customer management", "clarify", "Inventory + CRM - ambiguous primary"),
    ("Build a booking system with forms", "booking-app", "Booking is primary, forms are inputs"),
]


# HARD: Technical jargon and domain-specific language
JARGON_EXAMPLES = [
    ("Build a CRUD app for contacts", "crm", "CRUD contacts = CRM"),
    ("RESTful API for todos", "todo-app", "API for todos = todo app"),
    ("SPA for project management", "kanban", "Project management SPA → kanban"),
    ("MVP for customer onboarding", "form-builder", "Onboarding forms → form builder"),
    ("Build a ticketing system", "kanban", "Tickets in columns → kanban"),
    ("Issue tracker", "kanban", "Issue tracking = kanban-style"),
    ("Helpdesk portal", "ai-chat", "Helpdesk with chat → ai-chat"),
    ("POS system", "none", "Point of sale not in templates"),
    ("ERP system", "none", "Enterprise resource planning too complex"),
    ("OKR tracker", "todo-app", "OKRs can be tracked as tasks"),
]


# HARD: Requests with irrelevant context
NOISY_EXAMPLES = [
    ("My boss wants me to build a todo app by Friday", "todo-app", "Ignore deadline context"),
    ("I'm a developer and I need a CRM for my freelance business", "crm", "Ignore role context"),
    ("We're a startup of 10 people and need kanban", "kanban", "Ignore company size"),
    ("Build something like Trello", "kanban", "Trello = kanban board"),
    ("Something like Quickbooks but simpler", "expense-tracker", "Quickbooks ≈ expense tracking"),
    ("Like Calendly but for my salon", "booking-app", "Calendly = appointment booking"),
    ("Typeform clone", "form-builder", "Typeform = form builder"),
    ("Build me a Notion-like app", "none", "Notion is too broad/complex"),
]


def create_trainset() -> List[dspy.Example]:
    """Create training dataset from examples."""
    examples = []
    
    # Add direct match examples (easy)
    for request, template, reasoning in DIRECT_MATCH_EXAMPLES:
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=""
        ).with_inputs("user_request"))
    
    # Add ambiguous examples (should ask clarification)
    for request, template, reasoning in AMBIGUOUS_EXAMPLES:
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question="What type of application do you need?"
        ).with_inputs("user_request"))
    
    # Add edge cases (hard - competing templates)
    for request, template, reasoning in EDGE_CASE_EXAMPLES:
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=""
        ).with_inputs("user_request"))
    
    # Add misleading examples (hard - language traps)
    for request, template, reasoning in MISLEADING_EXAMPLES:
        clarify_q = "" if template not in ["clarify", "none"] else "Could you be more specific about what you're trying to accomplish?"
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=clarify_q
        ).with_inputs("user_request"))
    
    # Add negative examples (hard - explicit exclusions)
    for request, template, reasoning in NEGATIVE_EXAMPLES:
        clarify_q = "" if template not in ["clarify", "none"] else "What type of application would you prefer instead?"
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=clarify_q
        ).with_inputs("user_request"))
    
    # Add compound examples (hard - multiple features)
    for request, template, reasoning in COMPOUND_EXAMPLES:
        clarify_q = "" if template not in ["clarify", "none"] else "Which feature is most important to start with?"
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=clarify_q
        ).with_inputs("user_request"))
    
    # Add jargon examples (hard - technical language)
    for request, template, reasoning in JARGON_EXAMPLES:
        clarify_q = "" if template not in ["clarify", "none"] else "Could you describe what you're trying to build in simpler terms?"
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=clarify_q
        ).with_inputs("user_request"))
    
    # Add noisy examples (hard - irrelevant context)
    for request, template, reasoning in NOISY_EXAMPLES:
        clarify_q = "" if template not in ["clarify", "none"] else "What specific features do you need?"
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=clarify_q
        ).with_inputs("user_request"))
    
    return examples


def create_testset() -> List[dspy.Example]:
    """Create CHALLENGING test dataset (held out from training)."""
    # These are hard cases specifically designed to test the model
    test_examples = [
        # Direct but less common phrasing
        ("Make me a checklist thing", "todo-app", "Informal language → todo"),
        ("Money in/money out tracker", "expense-tracker", "Informal finance → expense"),
        
        # Hard edge cases
        ("I need to track my team's work in columns", "kanban", "Team + columns → kanban"),
        ("Track what items we have in the warehouse", "inventory", "Items + warehouse → inventory"),
        ("Book consultations with clients", "booking-app", "Consultations → appointments → booking"),
        
        # Misleading - should NOT match obvious choice
        ("Track my running", "none", "Fitness not in templates"),
        ("Shopping list app", "todo-app", "Shopping list ≈ checklist → todo"),
        ("Price tracker", "none", "Price comparison not in templates"),
        
        # Negative tests
        ("Task manager without boards", "todo-app", "Explicit: no kanban"),
        ("Customer data but no scheduling", "crm", "CRM without booking"),
        
        # Compound - requires clarification
        ("CRM with inventory features", "clarify", "Two major templates"),
        
        # Technical jargon
        ("JIRA-like app", "kanban", "JIRA ≈ issue tracking ≈ kanban"),
        ("Airtable clone", "none", "Airtable too complex/general"),
        
        # Very ambiguous
        ("Something for small business", "clarify", "Zero specifics"),
        ("Productivity tool", "clarify", "Could be many templates"),
        
        # Noisy but clear intent
        ("Our team (we're remote btw) needs a kanban for our agile sprints", "kanban", "Ignore noise, extract kanban"),
        ("My wife runs a hair salon and needs appointment booking", "booking-app", "Extract booking intent"),
        
        # No match cases
        ("Build me a weather dashboard", "none", "Weather not supported"),
        ("Email client", "none", "Email not in templates"),
        ("Build Slack", "none", "Chat platform too complex"),
    ]
    
    examples = []
    for request, template, reasoning in test_examples:
        if template == "clarify":
            clarify_q = "Could you tell me more about what specific features you need?"
        elif template == "none":
            clarify_q = ""  # No clarification needed for "none" - just explain limitation
        else:
            clarify_q = ""
            
        examples.append(dspy.Example(
            user_request=request,
            selected_template=template,
            reasoning=reasoning,
            clarifying_question=clarify_q
        ).with_inputs("user_request"))
    
    return examples


def split_dataset(ratio: float = 0.8) -> Tuple[List[dspy.Example], List[dspy.Example]]:
    """Split all examples into train/test sets."""
    import random
    
    all_examples = create_trainset()
    random.shuffle(all_examples)
    
    split_idx = int(len(all_examples) * ratio)
    return all_examples[:split_idx], all_examples[split_idx:]


# ============================================================
# Schema Modification Examples
# ============================================================

# Format: (user_request, template, existing_models, target_model, field_name, field_type, is_optional, reasoning)
SCHEMA_MODIFICATION_EXAMPLES = [
    # CRM schema modifications
    (
        "Build me a CRM and add a way to track each contact's LinkedIn profile",
        "crm", "Contact, Company, Tag, Note, Deal",
        "Contact", "linkedIn", "String", True,
        "User wants to store LinkedIn URLs for contacts - add optional String field"
    ),
    (
        "Set up a CRM. I want to know when I last talked to each contact",
        "crm", "Contact, Company, Tag, Note, Deal",
        "Contact", "lastContactedAt", "DateTime", True,
        "User wants to track last contact date - add optional DateTime field"
    ),
    (
        "Create a CRM. I want to mark deals as hot, warm, or cold",
        "crm", "Contact, Company, Tag, Note, Deal",
        "Deal", "temperature", "String", True,  # Could also be enum
        "User wants deal temperature/priority - add String field (or enum)"
    ),
    (
        "Build a CRM. I need to track expected close dates for deals",
        "crm", "Contact, Company, Tag, Note, Deal",
        "Deal", "expectedCloseDate", "DateTime", True,
        "User wants to forecast sales - add DateTime field for expected close"
    ),
    
    # Inventory schema modifications
    (
        "Build me an inventory tracker. I need to store barcodes for products",
        "inventory", "Product, Category, Supplier, StockMovement",
        "Product", "barcode", "String", True,
        "User wants barcode scanning support - add String field for barcode"
    ),
    (
        "Create an inventory system. I need to track where each product is stored",
        "inventory", "Product, Category, Supplier, StockMovement",
        "Product", "location", "String", True,
        "User wants shelf/location tracking - add String field for location"
    ),
    (
        "Build inventory software for my grocery store. Track expiration dates",
        "inventory", "Product, Category, Supplier, StockMovement",
        "Product", "expirationDate", "DateTime", True,
        "Grocery store needs expiration tracking - add DateTime field"
    ),
    (
        "I sell t-shirts. I need to track different sizes (S, M, L, XL)",
        "inventory", "Product, Category, Supplier, StockMovement",
        "Product", "size", "String", True,
        "Clothing store needs size variants - add String field (or create ProductVariant model)"
    ),
    
    # Todo schema modifications
    (
        "Build a todo app. I want to add priority levels to my tasks",
        "todo-app", "Todo, User",
        "Todo", "priority", "String", True,  # Could be enum: LOW, MEDIUM, HIGH
        "User wants task prioritization - add String field for priority"
    ),
    (
        "Create a task tracker. I need due dates for tasks",
        "todo-app", "Todo, User",
        "Todo", "dueDate", "DateTime", True,
        "User wants deadline tracking - add DateTime field for due date"
    ),
    (
        "Build a todo list. I want categories for my tasks",
        "todo-app", "Todo, User",
        "Todo", "category", "String", True,  # Or create a Category model
        "User wants task organization - add String field for category"
    ),
    (
        "Make a checklist app. I want to track who assigned each task",
        "todo-app", "Todo, User",
        "Todo", "assignedBy", "String", True,
        "User wants assignment tracking - add String field for assigner"
    ),
    
    # Kanban schema modifications
    (
        "Build a kanban board. I need to track story points",
        "kanban", "Board, Column, Card",
        "Card", "storyPoints", "Int", True,
        "Agile team wants effort estimation - add Int field for story points"
    ),
    (
        "Create a project board. I want to assign cards to team members",
        "kanban", "Board, Column, Card",
        "Card", "assignee", "String", True,
        "User wants card assignment - add String field for assignee"
    ),
]


# Unsupported feature examples
# Format: (user_request, unsupported_feature, explanation, alternative)
UNSUPPORTED_FEATURE_EXAMPLES = [
    (
        "Build me a CRM that automatically sends follow-up emails",
        "automated email sending",
        "Automated email sending requires integration with email services (SendGrid, Mailchimp, etc.) which is not supported",
        "You can add a 'lastContactedAt' field to manually track when to follow up"
    ),
    (
        "Create inventory software that connects to my barcode scanner",
        "hardware integration",
        "Direct hardware integration with barcode scanners is not supported",
        "You can add a barcode field and manually enter or paste barcodes"
    ),
    (
        "Build a CRM. Import all my contacts from Salesforce",
        "external data import",
        "Direct import from Salesforce or other external systems is not supported",
        "You can manually add contacts or use the API to import data programmatically"
    ),
    (
        "Build inventory software that automatically reorders when stock is low",
        "automated purchasing/ordering",
        "Automatic ordering requires integration with supplier systems which is not supported",
        "You can set minQuantity alerts and manually reorder when notified"
    ),
    (
        "I have 500 products in Excel. Import them into inventory",
        "bulk data import from files",
        "Direct Excel/CSV import is not built into the templates",
        "You can add products manually or use the database directly for bulk import"
    ),
    (
        "Build a chat app with real-time messaging",
        "real-time websockets",
        "Real-time websocket connections are not supported in the current architecture",
        "You can build a polling-based chat or AI chat assistant instead"
    ),
    (
        "Create a booking system with Stripe payments",
        "payment processing",
        "Payment processing integration (Stripe, PayPal, etc.) is not supported",
        "You can track bookings and handle payments externally"
    ),
]


def create_schema_trainset() -> List[dspy.Example]:
    """Create training dataset for schema modification optimization."""
    examples = []
    
    for (request, template, models, target, field, ftype, optional, reasoning) in SCHEMA_MODIFICATION_EXAMPLES:
        examples.append(dspy.Example(
            user_request=request,
            template=template,
            existing_models=models,
            needs_schema_change=True,
            target_model=target,
            field_name=field,
            field_type=ftype,
            is_optional=optional,
            reasoning=reasoning
        ).with_inputs("user_request", "template", "existing_models"))
    
    # Add some "no change needed" examples
    no_change_examples = [
        ("Build me a CRM", "crm", "Contact, Company, Tag, Note, Deal", "User just wants basic CRM, no modifications"),
        ("Create an inventory tracker", "inventory", "Product, Category, Supplier, StockMovement", "Basic inventory request"),
        ("Make a todo app", "todo-app", "Todo, User", "Standard todo app, no customizations"),
        ("I need a kanban board", "kanban", "Board, Column, Card", "Basic kanban request"),
    ]
    
    for (request, template, models, reasoning) in no_change_examples:
        examples.append(dspy.Example(
            user_request=request,
            template=template,
            existing_models=models,
            needs_schema_change=False,
            target_model="",
            field_name="",
            field_type="",
            is_optional=True,
            reasoning=reasoning
        ).with_inputs("user_request", "template", "existing_models"))
    
    return examples


def create_schema_testset() -> List[dspy.Example]:
    """Create test dataset for schema modification."""
    test_examples = [
        # Harder variations
        (
            "CRM for my recruiting agency - I need to track candidate skills",
            "crm", "Contact, Company, Tag, Note, Deal",
            "Contact", "skills", "String", True,
            "Recruiting use case - skills are like tags but on Contact"
        ),
        (
            "Inventory for my bakery - need to track batch numbers",
            "inventory", "Product, Category, Supplier, StockMovement",
            "Product", "batchNumber", "String", True,
            "Food safety requirement - batch tracking"
        ),
        (
            "Todo app where I can add notes to each task",
            "todo-app", "Todo, User",
            "Todo", "notes", "String", True,
            "User wants extended description/notes field"
        ),
        # Should NOT need changes
        (
            "Just build me a simple todo list",
            "todo-app", "Todo, User",
            "", "", "", True,
            "Simple request, no modifications"
        ),
    ]
    
    examples = []
    for (request, template, models, target, field, ftype, optional, reasoning) in test_examples:
        examples.append(dspy.Example(
            user_request=request,
            template=template,
            existing_models=models,
            needs_schema_change=bool(target),
            target_model=target,
            field_name=field,
            field_type=ftype,
            is_optional=optional,
            reasoning=reasoning
        ).with_inputs("user_request", "template", "existing_models"))
    
    return examples


def create_unsupported_trainset() -> List[dspy.Example]:
    """Create training dataset for unsupported feature detection."""
    examples = []
    
    for (request, feature, explanation, alternative) in UNSUPPORTED_FEATURE_EXAMPLES:
        examples.append(dspy.Example(
            user_request=request,
            is_unsupported=True,
            unsupported_feature=feature,
            explanation=explanation,
            alternative_suggestion=alternative
        ).with_inputs("user_request"))
    
    # Add supported examples (not unsupported)
    supported = [
        "Build me a CRM",
        "Create an inventory tracker",
        "I need a todo app with priorities",
        "Build a kanban board for my team",
        "Make a booking system for appointments",
        "CRM with LinkedIn field for contacts",
        "Inventory with expiration dates",
    ]
    
    for request in supported:
        examples.append(dspy.Example(
            user_request=request,
            is_unsupported=False,
            unsupported_feature="",
            explanation="",
            alternative_suggestion=""
        ).with_inputs("user_request"))
    
    return examples


# For quick testing
if __name__ == "__main__":
    trainset = create_trainset()
    testset = create_testset()
    schema_train = create_schema_trainset()
    schema_test = create_schema_testset()
    unsupported_train = create_unsupported_trainset()
    
    print(f"Template selection - Training: {len(trainset)}, Test: {len(testset)}")
    print(f"Schema modification - Training: {len(schema_train)}, Test: {len(schema_test)}")
    print(f"Unsupported features - Training: {len(unsupported_train)}")
    
    print("\nSample schema modification example:")
    print(schema_train[0])
