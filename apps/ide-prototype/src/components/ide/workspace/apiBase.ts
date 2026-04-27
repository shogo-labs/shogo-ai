/**
 * Base URL for the skill server.
 *
 * In canvas mode the Vite `/api` proxy targets port 3001 (dead), so we hit
 * the skill server directly on localhost. In a production deploy, set
 * `VITE_SKILL_SERVER_URL=""` so fetches become same-origin.
 *
 * The skill server port follows a predictable pattern in this runtime:
 *   app    = 37XYZ  (external)       /  38XYZ (internal)
 *   skill  = 38XYZ + 1
 *
 * We derive it from `window.location.port` so tab rotation across sessions
 * keeps working without code changes.
 */
function inferBase(): string {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env;
  const override = env?.VITE_SKILL_SERVER_URL;
  if (typeof override === "string") return override;

  if (typeof window !== "undefined" && window.location?.port) {
    const port = parseInt(window.location.port, 10);
    // External app port (37XXX) → skill port = (port + 1001)
    // Internal app port (38XXX) → skill port = (port + 1)
    if (port >= 37000 && port < 38000) {
      return `http://localhost:${port + 1001}`;
    }
    if (port >= 38000 && port < 40000) {
      return `http://localhost:${port + 1}`;
    }
  }
  return "http://localhost:38601";
}

export const API_BASE: string = inferBase();

/** Prepend API_BASE to a path that should start with `/api/...`. */
export const api = (path: string) => `${API_BASE}${path}`;
