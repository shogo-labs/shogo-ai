/**
 * Base URL for the project's API server.
 *
 * In canvas mode the Vite `/api` proxy targets the runtime, which proxies
 * `/api/*` to the project's `server.tsx` (port 3001 inside the VM /
 * pod). For local IDE dev outside the runtime sandbox, set
 * `VITE_API_BASE_URL=""` so fetches stay same-origin.
 *
 * Historically a separate "skill server" lived on its own port; that's
 * been folded into the project's own backend. The legacy
 * `VITE_SKILL_SERVER_URL` env override is still honoured for backwards
 * compatibility.
 */
function inferBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const override = env?.VITE_API_BASE_URL ?? env?.VITE_SKILL_SERVER_URL;
  if (typeof override === "string") return override;
  // Default: same-origin. The runtime proxies `/api/*` to the project
  // server, so a relative URL works in both pod + local-runtime modes.
  return "";
}

export const API_BASE: string = inferBase();

/** Prepend API_BASE to a path that should start with `/api/...`. */
export const api = (path: string) => `${API_BASE}${path}`;
