/**
 * Dev-only helper for manually testing the Proposals UI without wiring a real
 * agent endpoint. Imported from Workbench.tsx behind `import.meta.env.DEV`,
 * which means the module — and the entire `diff` import graph it touches —
 * is tree-shaken out of production builds via Vite's `import.meta.env.DEV`
 * dead-code elimination.
 *
 * Usage from devtools console:
 *   __shogoSim.proposeEdit('src/foo.ts', '/* new content *\/')
 *   __shogoSim.proposeEdit('src/foo.ts', 'new', { rationale: 'why' })
 */
import { proposalStore } from "../workspace/proposalStore";

declare global {
  interface Window {
    __shogoSim?: {
      proposeEdit: (
        path: string,
        after: string,
        opts?: { rootId?: string; rationale?: string },
      ) => Promise<unknown>;
      list: () => unknown;
      clear: () => void;
    };
  }
}

if (typeof window !== "undefined") {
  window.__shogoSim = {
    proposeEdit: (path, after, opts) =>
      proposalStore.propose({
        rootId: opts?.rootId ?? "agent",
        path,
        after,
        source: "agent",
        rationale: opts?.rationale,
      }),
    list: () => proposalStore.list(),
    clear: () => proposalStore.rejectAllProposals(),
  };

   
  console.info(
    "[shogo] dev helper attached: window.__shogoSim.proposeEdit(path, content)",
  );
}
