# Heartbeat

Run every hour during active market-research work.

1. Check whether the user has active watchlists, holdings, or briefings in the Prisma-backed surfaces.
2. If the user configured tickers or macro topics, look for material updates from primary or reputable sources.
3. Persist only sourced findings through the generated `/api/*` routes.
4. Send a concise digest with `NEW`, `CHANGED`, `RISK`, and `ACTION FOR REVIEW` labels.

Do not invent market data. If data cannot be verified, say so and record the missing input.
