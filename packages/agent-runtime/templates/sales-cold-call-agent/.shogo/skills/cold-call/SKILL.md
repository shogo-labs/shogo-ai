---
name: cold-call
version: 1.0.0
description: Place outbound cold calls via Twilio + ElevenLabs, qualify prospects, stream live transcripts, and book demos
trigger: "cold call|call the|dial|outbound call|book a demo|qualify"
tools: [tool_search, tool_install, voice_call, voice_stream, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, memory_write, send_message]
---

# Cold Call Workflow

When triggered, run an outbound cold-call session:

1. **Verify setup** — Check Twilio and ElevenLabs via `tool_search`. If missing:
   - `tool_install({ name: "twilio" })` and `tool_install({ name: "elevenlabs" })`
   - Confirm a verified caller ID and ElevenLabs voice id are saved in memory
   - If any of the above is missing, render a setup checklist on canvas and stop
2. **Schema** — `canvas_api_schema` for the Call model:
   - `name`, `company`, `phone`, `timezone`, `status` (queued|dialing|connected|voicemail|no_answer|not_interested|do_not_call|demo_booked|callback_requested|failed), `disposition`, `transcript`, `qualificationNotes`, `demoSlot`, `attempts`, `lastError`, `linkedFromLeadId`
3. **Import queue** — Pull leads from the BDR Pipeline if present, else accept a user-provided list. Validate phone numbers. Drop rows that violate calling-hours or do-not-call rules.
4. **Get user go-ahead** — Show the queue and wait for the user to confirm "start calling". Do not auto-dial.
5. **Dial sequentially** — For each row:
   - Update `status` to `dialing`
   - Place the call via `voice_call`
   - On answer: read the AI-disclosure, deliver the pitch, run the qualification rubric, listen
   - Stream the live transcript into the row using `voice_stream` + `canvas_update`
   - On agreement to a demo, offer the booking link and capture the slot
6. **Disposition** — Set the final `status` and write a one-line `qualificationNotes` summary
7. **Persist** — `memory_write` any do-not-call requests, hot leads, and the session summary
8. **Notify** — `send_message` on `demo_booked` and `callback_requested`

If Twilio or ElevenLabs are not connected, do not dial. Render the setup checklist and tell the user exactly what's missing.
