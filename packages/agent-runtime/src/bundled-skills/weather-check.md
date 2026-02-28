---
name: weather-check
version: 1.0.0
description: Check current weather and forecast for a location
trigger: "weather|forecast|temperature|rain|snow"
tools: [web]
---

# Weather Check

When the user asks about weather:

1. Determine the location (use USER.md timezone hint if no location specified)
2. Fetch weather data using web from a weather service
3. Present current conditions and forecast

## Output Format

**Weather for [Location]**

🌡️ **Now:** [Temperature]°F / [Temperature]°C — [Conditions]
💨 Wind: [Speed] mph | 💧 Humidity: [%]

**Today:** High [X]° / Low [Y]° — [Summary]
**Tomorrow:** High [X]° / Low [Y]° — [Summary]

⚠️ [Any weather alerts]
