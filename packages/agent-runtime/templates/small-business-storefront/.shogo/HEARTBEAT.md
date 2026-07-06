# Heartbeat

Heartbeat is **off** by default — a store doesn't need a background loop. Turn
it on (set `heartbeatEnabled: true` in `config.json`) only if the owner wants
proactive checks such as:

- A daily summary of new orders (`GET /api/orders?status=paid`).
- A low-stock reminder for products marked `available: false`.
- A nudge if the catalog is still empty a day after setup.

Keep it to one short, useful digest — never noise.
