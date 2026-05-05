---
name: ingest
version: 1.0.0
description: Capture any source (URL, PDF, audio, video, image, text) into the knowledge vault — extracts entities and claims, rewrites existing notes, flags contradictions
trigger: "ingest|save|capture|add source|read this|import|bookmark|clip|highlight"
tools: [web, browser, shell_exec, read_file, edit_file, memory_write, canvas_update, canvas_api_schema, canvas_api_seed]
---

# Source Ingestion

When triggered, process the incoming source into the knowledge vault.

## Supported Source Types

| Type | Method |
|------|--------|
| URL (article, blog) | Fetch via `web` or `browser`, extract main content |
| PDF | Download and extract text via `shell_exec` |
| Audio (voice memo) | Transcribe via Whisper, then process as text |
| Video (YouTube) | Pull transcript via `web`, extract key claims |
| Image (screenshot) | OCR via vision, extract text and entities |
| Plain text | Process directly |

## Ingestion Pipeline

1. **Parse** — Extract raw content from the source. Identify the source type and use the appropriate extraction method.

2. **Extract** — From the raw content, identify:
   - **Entities:** people, companies, technologies, concepts
   - **Claims:** factual statements with confidence levels
   - **Decisions:** choices made or recommended
   - **Action items:** tasks or follow-ups mentioned
   - **Temporal markers:** dates, time ranges, "as of" qualifiers

3. **Match** — For each extracted entity/claim, search the vault:
   - `GET /api/notes?search=<entity>` to find existing notes
   - Check entity overlap, not just title matching

4. **Rewrite or Create** — This is the critical step:
   - **If existing note found:** `PATCH /api/notes/:id` with the REWRITTEN content. The note must be self-contained — a reader should never need to check the history. Update `last_verified`, `confidence`, and `related_notes`.
   - **If no existing note:** `POST /api/notes` with full frontmatter:
     ```
     title, content, source, sourceUrl, confidence, entityType,
     entities (JSON), relatedNotes (JSON), factTrueFrom, factTrueUntil,
     vaultLearned (now)
     ```

5. **Cross-reference** — Update `related_notes` on all affected notes. Every note that shares entities with the new content should link to it.

6. **Contradiction check** — Compare new claims against existing vault knowledge:
   - If a claim contradicts an existing note, create a contradiction record:
     `POST /api/contradictions` with both note IDs, the conflicting claims, and evidence strength for each side.
   - Do NOT silently overwrite — flag and let the user reconcile.

7. **Summarize** — Report to the user:
   ```
   INGESTED: <source title>
   UPDATED: <N> existing notes
   CREATED: <N> new notes
   CONTRADICTIONS: <N> flagged (list them)
   ENTITIES: <comma-separated list>
   ```

## Citation Format

Every claim traced to this source must include:
- Source name and URL
- Date accessed
- Confidence: high (primary source, verified) | medium (reputable secondary) | low (single unverified source)

## Frontmatter Template

```yaml
source: "<source name>"
sourceUrl: "<url>"
confidence: "medium"
last_verified: "2026-05-05"
related_notes: ["<note-id-1>", "<note-id-2>"]
entities: ["<entity1>", "<entity2>"]
created: "2026-05-05"
vault_learned: "2026-05-05"
fact_true_from: "<date>"
fact_true_until: "present"
```
