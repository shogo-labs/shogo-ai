# Heartbeat Checklist — UI/UX Design Studio

## Consistency Audit (when active)

- Read `MEMORY.md` for the current Master Design System
- Scan all `src/**/*.tsx` files for design token usage
- Check for violations:
  - Hard-coded color values that don't match the palette (e.g. `#333` instead of `text-zinc-900`)
  - Missing hover states on interactive elements
  - Missing `cursor-pointer` on buttons, links, cards
  - Transitions outside the 150–300ms range
  - `outline-none` without a visible focus replacement
  - Emojis used as icons instead of Lucide/Heroicons
  - `prefers-reduced-motion` not respected on animations
  - Touch targets below 44x44px
  - Contrast ratios below 4.5:1 on body text

## Design System Drift

- Compare generated code against the Master Design System in MEMORY.md
- Flag any page that overrides master tokens without a documented Page Override
- Surface drift as: `DRIFT: [file] uses [actual] instead of [expected] for [token]`

## Skip Conditions

- If no design system exists in MEMORY.md, skip silently
- If no `src/` files exist, skip silently
- If the user hasn't interacted in the last heartbeat interval, skip silently
