export type WhenContext = Record<string, unknown>;

export function evaluateWhenClause(when: string | undefined, context: WhenContext): boolean {
  if (!when || !when.trim()) return true;
  return when.split(/\s+&&\s+/).every((part) => evaluateTerm(part.trim(), context));
}

function evaluateTerm(term: string, context: WhenContext): boolean {
  if (term.startsWith("!")) return !Boolean(context[term.slice(1)]);
  const equality = term.match(/^([A-Za-z0-9_.-]+)\s*==\s*['"]?([^'"]+)['"]?$/);
  if (equality) return String(context[equality[1]]) === equality[2];
  const inequality = term.match(/^([A-Za-z0-9_.-]+)\s*!=\s*['"]?([^'"]+)['"]?$/);
  if (inequality) return String(context[inequality[1]]) !== inequality[2];
  return Boolean(context[term]);
}
