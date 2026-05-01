# Heartbeat Checklist

## Call Hygiene
- Flag any call stuck in `dialing` for more than 2 minutes
- Surface failed calls (no audio, dropped, integration error) with the underlying error code

## Follow-up
- For `callback_requested`, queue the callback at the requested time/timezone
- For `demo_booked`, confirm the calendar event was created and the prospect received the invite

## Compliance
- Re-read the do-not-call list from memory and ensure no row in the queue matches
- Reject any row whose local time is outside 8am–9pm
