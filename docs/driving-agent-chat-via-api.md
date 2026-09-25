# Driving agent chat through the API

Use `scripts/shogo-chat.ts` for long-running agent turns:

```sh
SHOGO_KEY="$SHOGO_KEY" bun scripts/shogo-chat.ts \
  PROJECT_ID SESSION_ID "Run the requested task"
```

The key is read from `SHOGO_KEY`; do not put credentials in the message,
command arguments, or a checked-in file. Use `@/path/to/message.md` for a
large request.

The driver uses these API endpoints:

- `POST /api/projects/:projectId/chat` starts a turn. It sends
  `X-Chat-Session-Id` and `chatSessionId` so the turn is resumable.
- `GET /api/projects/:projectId/chat/:chatSessionId/turn` returns the durable
  status and latest sequence number.
- `GET /api/projects/:projectId/chat/:chatSessionId/stream?fromSeq=N` replays
  or tails the stream starting at sequence `N`.

The initial streaming connection can be closed by an edge proxy while the
server-side turn remains active. The driver therefore persists each parsed
SSE event to a local JSONL transcript, checks the turn snapshot after a
disconnect, and resumes from the next sequence. The stream is a live tail
while a turn is active, so resumed reads are bounded and retried.

Turn state and stream history are retained for a limited period. Persist the
events as they arrive rather than waiting until a long turn finishes.

`POST /api/projects/:projectId/chat/stop` is not a sufficient confirmation
that generation stopped. After requesting a stop, verify the result with the
turn snapshot and treat only a non-active status as confirmation.
