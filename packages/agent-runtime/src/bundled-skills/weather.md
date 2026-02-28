---
name: weather
version: 1.0.0
description: Get current weather and forecast for a location
trigger: "weather|forecast|temperature|how hot|how cold|rain today"
tools: [web]
---

# Weather

When the user asks about weather:

1. **Identify location** from the message (city, zip code, or region)
2. **Fetch weather data** using wttr.in (no API key needed):
   - Current: `web("https://wttr.in/LOCATION?format=j1")`
   - Simple: `web("https://wttr.in/LOCATION?format=3")`
3. **Present** current conditions and forecast

## Output Format

### Weather for [Location]

**Now:** 72°F / 22°C — Partly Cloudy
**Feels like:** 70°F / 21°C
**Humidity:** 45% | Wind: 8 mph NW

**Today:** High 78°F, Low 62°F — Afternoon showers possible
**Tomorrow:** High 75°F, Low 60°F — Sunny
**Day After:** High 80°F, Low 64°F — Clear

If the user didn't specify a location, ask them or check USER.md for a default location.
