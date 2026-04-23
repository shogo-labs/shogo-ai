export interface FuzzyMatch {
  score: number;
  indices: number[];
}

/**
 * Lightweight fuzzy scorer — matches characters of `needle` (in order)
 * against `haystack`, favoring consecutive runs and start-of-word hits.
 * Returns null if any needle char is missing. Case-insensitive.
 */
export function fuzzyMatch(needle: string, haystack: string): FuzzyMatch | null {
  if (!needle) return { score: 0, indices: [] };
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let hi = 0;
  let prevMatched = -2;
  let score = 0;
  const indices: number[] = [];

  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === c) {
        found = hi++;
        break;
      }
      hi++;
    }
    if (found === -1) return null;
    indices.push(found);
    // base hit
    score += 1;
    // consecutive match bonus
    if (found === prevMatched + 1) score += 5;
    // start-of-word bonus (path separator, dash, underscore, case change)
    const prev = haystack[found - 1];
    if (found === 0 || prev === "/" || prev === "-" || prev === "_" || prev === ".") {
      score += 8;
    } else if (haystack[found] !== haystack[found].toLowerCase()) {
      score += 4;
    }
    prevMatched = found;
  }
  // reward short haystacks
  score -= haystack.length * 0.01;
  return { score, indices };
}

export function highlightMatch(text: string, indices: number[]): React.ReactNode[] {
  if (!indices.length) return [text];
  const parts: React.ReactNode[] = [];
  let last = 0;
  const set = new Set(indices);
  let run = "";
  let runStart = -1;
  for (let i = 0; i < text.length; i++) {
    if (set.has(i)) {
      if (runStart === -1) {
        if (i > last) parts.push(text.slice(last, i));
        runStart = i;
      }
      run += text[i];
    } else if (runStart !== -1) {
      parts.push(
        <mark key={runStart} className="bg-transparent text-[color:var(--ide-active-ring)] font-semibold">
          {run}
        </mark>,
      );
      run = "";
      runStart = -1;
      last = i;
    }
  }
  if (runStart !== -1) {
    parts.push(
      <mark key={runStart} className="bg-transparent text-[color:var(--ide-active-ring)] font-semibold">
        {run}
      </mark>,
    );
    last = runStart + run.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
