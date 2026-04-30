/**
 * Client wrapper for /api/agent/action. The response shape matches the
 * server-side `runStubAgentAction` in apps/ide-prototype/server.ts.
 */
import { API_BASE } from "../workspace/apiBase";

export type AgentAction = "explain" | "refactor" | "tests";

export interface AgentActionResult {
  /** "text" → display as Explain panel; "file" → route through writeFile (proposal). */
  kind: "text" | "file";
  /** Markdown-ish body for kind:"text". */
  body?: string;
  /** Target path for kind:"file" — defaults to the source path. */
  path?: string;
  /** Proposed file content for kind:"file". */
  after?: string;
  /** Optional one-liner shown on the proposal card. */
  rationale?: string;
}

export interface RunAgentActionArgs {
  action: AgentAction;
  rootId: string;
  path: string;
  content: string;
  language?: string;
}

/**
 * Calls the backend agent endpoint. Resolves with a `null` result when the
 * server returned 204 (e.g. refactor produced no changes); throws on network
 * or 4xx/5xx errors.
 */
export async function runAgentAction(args: RunAgentActionArgs): Promise<AgentActionResult | null> {
  const res = await fetch(`${API_BASE}/api/agent/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: args.action,
      path: args.path,
      content: args.content,
      language: args.language,
    }),
  });
  if (res.status === 204) return null;
  const data = (await res.json().catch(() => ({}))) as AgentActionResult & { error?: string };
  if (!res.ok) {
    throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  }
  return data;
}
