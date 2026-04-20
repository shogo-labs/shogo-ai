/**
 * Base URL for the legacy skill-server endpoints.
 *
 * This file was copied from the Vite-based apps/ide-prototype where it read
 * import.meta.env.VITE_SKILL_SERVER_URL. In the apps/mobile port the bundler
 * is Metro and the web bundle is a classic script, so import.meta throws
 * `Uncaught SyntaxError: Cannot use 'import.meta' outside a module` at load
 * time — which blanks the page entirely.
 *
 * In the mobile IDE, real file/tree/read/write/rename/delete/mkdir/search
 * traffic flows through the SDK (workspace/sdkFs.ts) against the per-project
 * agent-runtime. The only remaining consumer of `api()` is the git-diff
 * fetch in Workbench.tsx, and git is a "backend pending" placeholder on
 * this branch — the route isn't mounted yet. So we just need a shim that
 * parses cleanly in Metro and resolves to same-origin for the day the git
 * routes land.
 *
 * Override in runtime (e.g. dev tooling) by setting
 * `window.__SHOGO_SKILL_SERVER_URL` before the IDE tab mounts.
 */
function inferBase(): string {
  if (typeof window !== "undefined") {
    const override = (window as unknown as { __SHOGO_SKILL_SERVER_URL?: string })
      .__SHOGO_SKILL_SERVER_URL;
    if (typeof override === "string") return override;
  }
  return "";
}

export const API_BASE: string = inferBase();

/** Prepend API_BASE to a path that should start with `/api/...`. */
export const api = (path: string) => `${API_BASE}${path}`;
