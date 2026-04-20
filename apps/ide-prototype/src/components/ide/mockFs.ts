import type { TreeNode } from "./types";

export const MOCK_TREE: TreeNode[] = [
  {
    name: "agent-workspace",
    path: "agent",
    kind: "dir",
    children: [
      {
        name: "src",
        path: "agent/src",
        kind: "dir",
        children: [
          {
            name: "App.tsx",
            path: "agent/src/App.tsx",
            kind: "file",
            language: "typescript",
          },
          {
            name: "main.tsx",
            path: "agent/src/main.tsx",
            kind: "file",
            language: "typescript",
          },
          {
            name: "index.css",
            path: "agent/src/index.css",
            kind: "file",
            language: "css",
          },
        ],
      },
      {
        name: "package.json",
        path: "agent/package.json",
        kind: "file",
        language: "json",
      },
      {
        name: "README.md",
        path: "agent/README.md",
        kind: "file",
        language: "markdown",
      },
    ],
  },
];

export const MOCK_FILES: Record<string, string> = {
  "agent/src/App.tsx": `import { Workbench } from "./components/ide/Workbench";

export default function App() {
  return <Workbench />;
}
`,
  "agent/src/main.tsx": `import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
`,
  "agent/src/index.css": `@import "tailwindcss";

:root {
  color-scheme: dark;
}

body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, sans-serif;
}
`,
  "agent/package.json": `{
  "name": "shogo-ide",
  "version": "0.1.0",
  "private": true
}
`,
  "agent/README.md": `# Shogo IDE — Phase 1

This is the Monaco + layout shell prototype.
`,
};
