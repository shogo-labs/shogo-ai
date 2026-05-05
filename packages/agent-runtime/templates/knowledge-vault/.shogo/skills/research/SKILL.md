---
name: research
version: 1.0.0
description: Deep research with citations — vault-first knowledge check then targeted web research to fill gaps
trigger: "research|look up|investigate|deep dive|what do we know about|explore topic|find out about"
tools: [web, browser, read_file, edit_file, memory_write, canvas_update, canvas_api_seed]
---

# Research Engine

When triggered, perform research in one of two modes based on context.

## Mode Selection

- **Quick research:** User wants a fast answer. Web search + summarize. Use when the query is narrow and time-sensitive.
- **Deep research (vault-first):** User wants comprehensive understanding. Scan vault first, identify gaps, then fill with targeted searches. Use when the topic is broad or the user says "deep dive."

## Quick Research Pipeline

1. **Search** — Use `web` to search 2–3 query variations
2. **Gather** — Visit top 3–5 results, extract key claims and data
3. **Summarize** — Structured response with:
   - Key findings (bullet points)
   - Sources table (name, URL, date, confidence)
   - Open questions
4. **Save** — Create research record:
   `POST /api/researches` with title, query, findings, citations (JSON), status: "complete", confidence

## Deep Research (Vault-First) Pipeline

1. **Vault scan** — Search existing vault knowledge on the topic:
   - `GET /api/notes?search=<topic>`
   - `GET /api/syntheses?search=<topic>`
   - Compile what the vault already knows

2. **Gap analysis** — Identify:
   - What the vault knows well (high confidence, multiple sources)
   - What the vault knows poorly (low confidence, single source, stale)
   - What the vault doesn't know at all
   - Questions the vault raises but doesn't answer

3. **Targeted search** — For each gap:
   - Formulate specific search queries
   - Use `web` to search, visit top results
   - Focus on filling gaps, not re-confirming known facts

4. **Delta report** — Present findings as changes to vault knowledge:
   ```
   RESEARCH: <topic>

   VAULT ALREADY KNOWS:
   - <fact> (confidence: high, from <source>)
   - <fact> (confidence: medium, from <source>)

   NEW FINDINGS:
   - <new fact> (source: <url>, confidence: <level>)
   - <updated fact> (was: <old>, now: <new>, source: <url>)

   CONTRADICTIONS WITH VAULT:
   - <vault says X, new source says Y>

   STILL UNKNOWN:
   - <question that research couldn't answer>

   SOURCES: <N> consulted, <M> cited
   ```

5. **Ingest** — Save all new findings as vault notes following the ingest skill pattern:
   - Rewrite existing notes with new info
   - Create new notes for new entities/claims
   - Flag contradictions
   - `POST /api/researches` with full metadata

## Citation Standard

Every factual claim must include:
```
[<claim>] — <source name>, <url>, <date accessed>, confidence: <high|medium|low>
```

Confidence levels:
- **High:** Primary source, peer-reviewed, official documentation, or 3+ independent sources agree
- **Medium:** Reputable secondary source, or 2 independent sources agree
- **Low:** Single source, unverified, opinion piece, or source known for unreliability

## Research Record Schema

```
title: "<topic>"
query: "<original user query>"
mode: "quick" | "deep"
findings: "<structured summary>"
citations: JSON array of { source, url, date, confidence, claim }
status: "complete" | "in_progress" | "needs_followup"
confidence: "high" | "medium" | "low"
gapsFilled: <number>
contradictionsFound: <number>
notesUpdated: <number>
notesCreated: <number>
```
