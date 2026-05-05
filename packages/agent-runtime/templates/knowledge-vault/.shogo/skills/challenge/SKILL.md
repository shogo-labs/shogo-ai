---
name: challenge
version: 1.0.0
description: Challenge user assumptions with their own vault history — surface past failures, reversed decisions, and contradicting evidence
trigger: "challenge|push back|devil's advocate|am I wrong|check my thinking|stress test|question my assumption|red team"
tools: [read_file, memory_write, canvas_update]
---

# Assumption Challenger

When triggered, use the user's own vault history to constructively challenge their current thinking.

## Challenge Pipeline

1. **Identify the claim** — Parse the user's statement into one or more testable claims.
   - "I think X will work" → test: has X (or similar) worked before?
   - "We should do Y" → test: have we tried Y before? What happened?
   - "Z is the best approach" → test: what alternatives exist in the vault?

2. **Vault search** — For each claim, search comprehensively:
   - `GET /api/notes?search=<claim keywords>` — direct matches
   - `GET /api/contradictions` — existing contradictions on this topic
   - `GET /api/syntheses?search=<topic>` — patterns that might be relevant
   - Search for: past failures on similar topics, reversed decisions, minority viewpoints, contradicting evidence from trusted sources

3. **Build the counter-case** — Assemble evidence:
   - Quote the user's own past words when possible ("On <date>, you noted: ...")
   - Cite vault sources with confidence levels
   - Identify the strongest counter-argument, not a straw man
   - Note if the user has changed their mind on this topic before

4. **Present constructively** — This is NOT adversarial:
   ```
   YOUR CLAIM: <restate clearly>

   VAULT EVIDENCE:
   - SUPPORTS: <evidence for the claim> (from <source>, <date>)
   - CHALLENGES: <evidence against> (from <source>, <date>)
   - PAST POSITION: <what you said about this before> (from <note>, <date>)

   STRONGEST COUNTER-ARGUMENT:
   <one paragraph making the best case against the claim>

   OPEN QUESTIONS:
   - <question the vault can't answer>
   - <question that would change the analysis>

   CONFIDENCE IN YOUR CLAIM: <high | medium | low>
   REASONING: <one sentence explaining the rating>

   Your vault, your call.
   ```

5. **Record** — Save the challenge interaction as a vault note:
   - Type: "challenge"
   - Link to all evidence notes cited
   - Record the user's final position (if stated)

## Principles

- Never be adversarial — you're a thinking partner, not a debate opponent
- Use the user's own words and history as primary evidence
- Strongest counter-arguments only — no straw men, no bad-faith readings
- If the vault has no relevant counter-evidence, say so honestly
- Always end with "Your vault, your call" — the user decides
