import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: "category",
      label: "Getting Started",
      collapsed: false,
      items: [
        "getting-started/welcome",
        "getting-started/quick-start",
        "getting-started/plans-and-credits",
        "getting-started/faq",
      ],
    },
    {
      type: "category",
      label: "Features",
      collapsed: false,
      items: [
        {
          type: "category",
          label: "Build",
          items: [
            "features/chat-with-ai",
            "features/project-editor",
            "features/live-preview",
            "features/database",
            "features/history-and-checkpoints",
          ],
        },
        {
          type: "category",
          label: "Collaborate",
          items: [
            "features/workspaces-and-members",
            "features/sharing-projects",
          ],
        },
        {
          type: "category",
          label: "Deploy & Host",
          items: [
            "features/publishing",
            "features/access-control",
          ],
        },
        {
          type: "category",
          label: "Account",
          items: [
            "features/account-settings",
            "features/billing",
          ],
        },
      ],
    },
    {
      type: "category",
      label: "Templates",
      items: [
        "templates/index",
        "templates/todo-app",
        "templates/crm",
        "templates/kanban",
        "templates/inventory",
        "templates/expense-tracker",
        "templates/booking-app",
        "templates/form-builder",
        "templates/feedback-form",
        "templates/ai-chat",
      ],
    },
    {
      type: "category",
      label: "Prompting Guide",
      items: [
        "prompting/basics",
        "prompting/prompt-patterns",
        "prompting/advanced-prompting",
        "prompting/troubleshooting-with-prompts",
      ],
    },
    {
      type: "category",
      label: "SDK (For Developers)",
      items: [
        "sdk/introduction",
        "sdk/authentication",
        "sdk/database",
        "sdk/email",
        "sdk/api-reference",
      ],
    },
    {
      type: "category",
      label: "Tips & Tricks",
      items: [
        "tips-and-tricks/best-practices",
        "tips-and-tricks/from-idea-to-app",
        "tips-and-tricks/common-patterns",
        "tips-and-tricks/troubleshooting",
        "tips-and-tricks/images-and-media",
      ],
    },
    {
      type: "category",
      label: "Reference",
      items: [
        "reference/glossary",
        "reference/keyboard-shortcuts",
        "reference/support",
      ],
    },
  ],
};

export default sidebars;
