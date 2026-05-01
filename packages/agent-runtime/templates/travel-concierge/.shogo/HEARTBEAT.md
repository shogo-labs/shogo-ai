# Heartbeat Checklist

Heartbeat is off by default for this template. Turn it on in `config.json`
(or via the agent settings UI) once the traveler has an active trip and
wants the agent to monitor it in the background.

## When a trip is active
- Re-check availability on top hotel pick(s) and any phone-only restaurants
  that haven't been confirmed yet — surface changes immediately.
- Watch for newly-opened reservations on bucket-list spots that were
  `unavailable` last pass.
- Pull weather and transit advisories for the destination on the day before
  arrival and the morning of arrival.
- Verify confirmed reservations are still active 24 hours before the booking.

## When no trip is active
- Skip silently. Don't ping the traveler with generic suggestions.
