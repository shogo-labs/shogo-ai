# Heartbeat Checklist

## Pipeline Hygiene
- Flag rows in `enriching` or `drafting` state for more than 1 hour
- Flag rows where Gmail draft creation failed
- Surface duplicates (same email or LinkedIn across rows)

## Reply Tracking
- If Gmail is connected, scan replies to queued drafts and update row status (replied / out-of-office / bounced)
- Alert via `send_message` on positive replies so the operator can follow up quickly

## ICP Drift
- Compare new leads against the saved ICP
- Flag rows that don't match the criteria for human review before drafting
