---
name: synthesize
version: 1.0.0
description: Scan recent vault notes for unnamed patterns across sources — create synthesis pages linking back to evidence
trigger: "synthesize|find patterns|connect dots|what themes|what patterns|connect the dots|emerging trends|what's recurring"
tools: [web, read_file, edit_file, memory_write, canvas_update, canvas_api_seed]
---

# Knowledge Synthesis

When triggered, perform a cross-source pattern analysis on recent vault notes.

## Synthesis Pipeline

1. **Gather** — Fetch recent notes from the vault:
   - Default window: last 7 days. User can specify 14 or 30 days.
   - `GET /api/notes?orderBy=updatedAt&order=desc&limit=50`
   - Focus on notes updated or created within the window.

2. **Cluster** — Group notes by:
   - Shared entities (people, companies, concepts)
   - Related topic areas
   - Temporal proximity (events happening around the same time)
   - Source diversity (same topic covered by multiple independent sources)

3. **Identify patterns** — Look for:
   - **Recurring themes:** concepts appearing in 3+ unrelated sources
   - **Emerging trends:** new entities/claims that appeared in the last 7 days across multiple sources
   - **Unresolved tensions:** contradictions that haven't been reconciled
   - **Knowledge gaps:** topics the user has engaged with but has thin vault coverage
   - **Convergence:** multiple independent sources reaching the same conclusion

4. **Create synthesis pages** — For each identified pattern:
   - `POST /api/syntheses` with:
     ```
     title: "<pattern name>"
     pattern: "<description of the pattern>"
     evidence: JSON array of note IDs that support this pattern
     evidenceCount: <number>
     confidence: "high" | "medium" | "low"
     patternType: "theme" | "trend" | "tension" | "gap" | "convergence"
     timeWindow: "<N> days"
     ```
   - Each synthesis must link back to at least 2 evidence notes.
   - Never create a synthesis from a single source.

5. **Update cross-references** — Add synthesis ID to the `related_notes` of all evidence notes.

6. **Report** — Summarize findings:
   ```
   SYNTHESIS PASS: <date range>
   NOTES SCANNED: <N>
   PATTERNS FOUND: <N>
   - THEME: <name> (supported by <N> notes)
   - TREND: <name> (emerged in last <N> days)
   - TENSION: <name> (unresolved between <note A> and <note B>)
   - GAP: <topic> (user has <N> notes but <M> open questions)
   ```

## Quality Criteria

- A synthesis is only worth creating if it reveals something the user wouldn't see by reading individual notes.
- Minimum 2 evidence notes from different sources.
- Confidence reflects evidence strength: high = 3+ independent sources agree, medium = 2 sources or same-source pattern, low = speculative connection.
- Re-run synthesis should update existing synthesis pages, not create duplicates.
