import { themes as prismThemes } from "prism-react-renderer";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Shogo Documentation",
  tagline: "Build AI agents through conversation",
  favicon: "img/favicon.ico",

  url: "https://docs.shogo.ai",
  baseUrl: "/",

  organizationName: "shogo-ai",
  projectName: "shogo-docs",

  onBrokenLinks: "throw",
  onBrokenMarkdownLinks: "warn",

  stylesheets: [
    {
      href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      type: "text/css",
    },
  ],

  plugins: [
    [
      "@docusaurus/plugin-client-redirects",
      {
        redirects: [
          {
            from: "/",
            to: "/getting-started/welcome",
          },
        ],
      },
    ],
  ],

  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          sidebarPath: "./sidebars.ts",
          routeBasePath: "/",
        },
        blog: {
          path: "changelog",
          routeBasePath: "changelog",
          blogTitle: "Changelog",
          blogDescription: "Latest updates and improvements to Shogo",
          blogSidebarTitle: "Recent updates",
          blogSidebarCount: "ALL",
          showReadingTime: false,
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    navbar: {
      title: "Shogo",
      logo: {
        alt: "Shogo Logo",
        src: "img/logo.svg",
        href: "/getting-started/welcome",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "docs",
          position: "left",
          label: "Documentation",
        },
        {
          to: "/changelog",
          label: "Changelog",
          position: "left",
        },
        {
          href: "https://shogo.dev",
          label: "Go to Shogo",
          position: "right",
          className: "navbar-cta",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Documentation",
          items: [
            { label: "Getting Started", to: "/getting-started/welcome" },
            { label: "Features", to: "/features/chat-with-ai" },
            { label: "Agent Templates", to: "/templates" },
            { label: "Prompting Guide", to: "/prompting/basics" },
          ],
        },
        {
          title: "Resources",
          items: [
            { label: "Tips & Tricks", to: "/tips-and-tricks/best-practices" },
            { label: "Glossary", to: "/reference/glossary" },
            { label: "Changelog", to: "/changelog" },
          ],
        },
        {
          title: "Product",
          items: [
            { label: "Website", href: "https://shogo.ai" },
            { label: "App", href: "https://shogo.dev" },
            { label: "Plans & Pricing", to: "/getting-started/plans-and-credits" },
            { label: "FAQ", to: "/getting-started/faq" },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Shogo AI. All rights reserved.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ["bash", "json", "typescript"],
    },
    colorMode: {
      defaultMode: "light",
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
