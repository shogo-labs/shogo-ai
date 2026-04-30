/**
 * Real-LLM backend for /api/agent/action. Provider-agnostic — speaks the
 * OpenAI Chat Completions API, which means it works with:
 *
 *   - OpenAI            api.openai.com/v1
 *   - Groq              api.groq.com/openai/v1
 *   - OpenRouter        openrouter.ai/api/v1
 *   - Together          api.together.xyz/v1
 *   - Ollama            http://localhost:11434/v1   (no key needed)
 *   - vLLM / LM Studio  http://localhost:8000/v1
 *
 * Configure via env (set in a shell before `bun run dev`, or in `.env`):
 *
 *   SHOGO_AGENT_PROVIDER     "stub" | "openai-compat"   (default: "stub")
 *   SHOGO_AGENT_API_BASE     e.g. "https://api.openai.com/v1"
 *   SHOGO_AGENT_API_KEY      bearer token (omit for Ollama)
 *   SHOGO_AGENT_MODEL        e.g. "gpt-4o-mini" or "llama3.2"
 *   SHOGO_AGENT_TIMEOUT_MS   default 30000
 *
 * If the provider call fails for any reason, the caller (server.ts) will fall
 * back to the deterministic stub so the IDE never gets stuck.
 */

interface AgentActionRequest {
  action: "explain" | "refactor" | "tests";
  path: string;
  content: string;
  language?: string;
}

interface AgentActionResult {
  kind: "text" | "file";
  body?: string;
  path?: string;
  after?: string;
  rationale?: string;
}

export function isLLMConfigured(): boolean {
  return (
    (process.env.SHOGO_AGENT_PROVIDER ?? "stub") === "openai-compat" &&
    !!process.env.SHOGO_AGENT_API_BASE &&
    !!process.env.SHOGO_AGENT_MODEL
  );
}

export async function runLLMAgentAction(req: AgentActionRequest): Promise<AgentActionResult | null> {
  switch (req.action) {
    case "explain":
      return { kind: "text", body: await chat(buildExplainPrompt(req)) };
    case "refactor": {
      const raw = stripCodeFence(await chat(buildRefactorPrompt(req)));
      if (!raw.trim()) return null;
      // LLMs commonly drop the trailing newline. Restore it so the proposal
      // diff doesn\'t show a phantom whitespace-only change.
      const after = preserveTrailingNewline(req.content, raw);
      if (normalize(after) === normalize(req.content)) return null;
      return { kind: "file", path: req.path, after, rationale: "LLM refactor" };
    }
    case "tests": {
      const raw = stripCodeFence(await chat(buildTestsPrompt(req)));
      if (!raw.trim()) return null;
      const testPath = inferTestPath(req.path);
      if (!testPath) return null;
      const after = raw.endsWith("\n") ? raw : raw + "\n";
      return { kind: "file", path: testPath, after, rationale: "LLM-generated tests" };
    }
  }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

interface ChatMessage { role: "system" | "user"; content: string }

async function chat(messages: ChatMessage[]): Promise<string> {
  const base = process.env.SHOGO_AGENT_API_BASE!;
  const key = process.env.SHOGO_AGENT_API_KEY;
  const model = process.env.SHOGO_AGENT_MODEL!;
  const timeout = Number(process.env.SHOGO_AGENT_TIMEOUT_MS ?? 30000);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        // Reasonable cap so a runaway model can't eat 100K tokens.
        max_tokens: 4096,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const out = data.choices?.[0]?.message?.content ?? "";
    return out.trim();
  } finally {
    clearTimeout(t);
  }
}

// ─── Prompts ─────────────────────────────────────────────────────────────────

const SYSTEM_FILE = `You are a senior software engineer assisting a developer inside an IDE. Output only the requested artifact — no preamble, no closing notes, no explanations. When asked for code, return the FULL file content. When you must wrap output in a code fence, use \`\`\`<lang> on its own line.`;

const SYSTEM_TEXT = `You are a senior software engineer. Answer concisely in markdown — short paragraphs and bullet points. No preamble.`;

function buildExplainPrompt(req: AgentActionRequest): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_TEXT },
    {
      role: "user",
      content:
        `Explain this file in plain English for a developer who has never seen it.\n` +
        `Cover: (1) its role in the project, (2) main exports, (3) any non-obvious logic or side effects.\n` +
        `Keep it under ~150 words.\n\n` +
        `Path: \`${req.path}\`\n\n` +
        codeBlock(req.content, req.language),
    },
  ];
}

function buildRefactorPrompt(req: AgentActionRequest): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_FILE },
    {
      role: "user",
      content:
        `Refactor this file for readability and maintainability. Preserve ALL behavior and the public API exactly. ` +
        `Do not add new dependencies. Improve names, dead code, types, and structure where clearly beneficial; ` +
        `if the file is already clean, return it unchanged.\n\n` +
        `Output the COMPLETE updated file content — no commentary, no diff, no markdown fences (or wrap in a single \`\`\`<lang> fence).\n\n` +
        `Path: \`${req.path}\`\n\n` +
        codeBlock(req.content, req.language),
    },
  ];
}

function buildTestsPrompt(req: AgentActionRequest): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_FILE },
    {
      role: "user",
      content:
        `Write a Vitest test file for the source below. Use \`describe\`, \`it\`, \`expect\` from "vitest". ` +
        `Cover the main exports with at least one meaningful assertion each (not just toBeDefined). ` +
        `Mock external dependencies as needed. Output ONLY the test file content — no commentary.\n\n` +
        `Source path: \`${req.path}\`\n\n` +
        codeBlock(req.content, req.language),
    },
  ];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function codeBlock(content: string, lang?: string): string {
  return "```" + (lang ?? "") + "\n" + content + "\n```";
}

/** Strips a single leading/trailing markdown code fence if present. */
function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  const fenceMatch = trimmed.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) return fenceMatch[1];
  // If only the leading fence was emitted (truncated), be lenient.
  if (trimmed.startsWith("```")) {
    const firstNl = trimmed.indexOf("\n");
    if (firstNl > 0) {
      const rest = trimmed.slice(firstNl + 1);
      return rest.endsWith("```") ? rest.slice(0, -3).trimEnd() : rest;
    }
  }
  return trimmed;
}

/** If the original ended with a newline, ensure the new content does too. */
function preserveTrailingNewline(original: string, next: string): string {
  if (original.endsWith("\n") && !next.endsWith("\n")) return next + "\n";
  if (!original.endsWith("\n") && next.endsWith("\n")) return next.replace(/\n+$/, "");
  return next;
}

/** Strip trailing whitespace for equivalence comparison. */
function normalize(s: string): string {
  return s.replace(/\s+$/, "");
}

function inferTestPath(srcPath: string): string | null {
  const m = srcPath.match(/^(.*?)([^/]+?)(\.[tj]sx?)$/);
  if (!m) return null;
  const [, dir, base, ext] = m;
  if (base.endsWith(".test") || base.endsWith(".spec")) return null;
  return `${dir}${base}.test${ext}`;
}
