---
name: bdr-prospect
version: 1.0.0
description: Research target accounts, enrich leads, draft personalized cold-email openers, and queue Gmail drafts for review
trigger: "bdr|prospect|cold email|cold outreach|outbound|lead list|enrich|series a|founders"
tools: [tool_search, tool_install, web, browser, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, memory_write, send_message]
---

# BDR Prospecting

When triggered, build or extend the BDR Pipeline:

1. **Confirm ICP** — Read `MEMORY.md` for saved ICP. If the user supplies new criteria, persist it. Required fields: industry, stage, geography, role, recency window.
2. **Source leads** — Use `web` and `browser` to find candidates that match the ICP. Validate stage and geography from a primary source (Crunchbase, official press release, SEC filing, company blog) — never just a LinkedIn headline.
3. **Schema** — Use `canvas_api_schema` to define the Lead model:
   - `name`, `role`, `company`, `companySize`, `stage`, `fundingDate`, `location`, `email`, `linkedin`, `recentSignal`, `signalSource`, `opener`, `draftStatus` (none|drafting|queued|sent|replied|bounced), `gmailDraftId`, `notes`
4. **Enrich rows** — `canvas_api_seed` rows in batches of 10. For each row, capture a real, dated `recentSignal` plus the URL it came from. If you cannot find a real signal, set `draftStatus` to `none` and `notes` to "needs research" rather than inventing one.
5. **Draft openers** — For each enriched row, write a personalized opener (under 90 words) that opens with the signal, ties it to the user's value prop, and ends with a low-friction CTA. Update the row's `opener` field.
6. **Connect Gmail** — Check via `tool_search({ query: "gmail" })`. If missing, `tool_install({ name: "gmail" })` so the user can OAuth. Do not proceed to drafts until Gmail is connected.
7. **Queue Gmail drafts** — Once Gmail is connected, call `GMAIL_CREATE_DRAFT` for each row using the user's sender identity. Save the returned draft id to `gmailDraftId` and set `draftStatus` to `queued`. Never send.
8. **Persist** — `memory_write` a summary: ICP used, total rows added, drafts queued, anything skipped and why.
9. **Notify** — `send_message` a one-line summary so the operator knows the batch is ready for review.

If Gmail isn't connected, build the pipeline and openers anyway, but stop before draft creation and tell the user exactly which step is blocked and how to unblock it.
