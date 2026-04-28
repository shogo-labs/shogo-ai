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
        "getting-started/plans-and-pricing",
        "getting-started/showcase",
        "getting-started/faq",
      ],
    },
    {
      type: "category",
      label: "Concepts",
      collapsed: false,
      items: [
        "concepts/heartbeat",
        "concepts/memory",
        "concepts/skills",
        "concepts/workspace-files",
        "concepts/canvas",
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
          label: "Account",
          items: [
            "features/account-settings",
            "features/billing",
          ],
        },
        {
          type: "category",
          label: "My Machines",
          items: [
            "features/my-machines/quickstart",
            "features/my-machines/networking",
            "features/my-machines/troubleshooting",
          ],
        },
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/github-monitoring",
        "guides/daily-digest",
        "guides/using-memory",
      ],
    },
    {
      type: "category",
      label: "Templates",
      items: [
        "templates/index",
        "templates/research-assistant",
        "templates/github-ops",
        "templates/support-desk",
        "templates/meeting-prep",
        "templates/revenue-tracker",
        "templates/project-board",
        "templates/incident-commander",
        "templates/personal-assistant",
      ],
    },
    {
      type: "category",
      label: "Prompting Guide",
      items: [
        "prompting/basics",
        "prompting/advanced-prompting",
        "prompting/troubleshooting-with-prompts",
      ],
    },
    {
      type: "category",
      label: "Tips & Tricks",
      items: [
        "tips-and-tricks/best-practices",
        "tips-and-tricks/troubleshooting",
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
