# Stack: Expo (React Native)

This project is an Expo + React Native app with TypeScript.

## Runtime

- **Bundler:** Metro, supervised by the runtime's PreviewManager. **Never run
  `expo start` or `npx expo start` from `exec`** — it has a 5-minute timeout
  and Metro is long-lived. The bundler is started for you.
- **Web preview:** Metro builds a web bundle via `react-native-web`. Most
  layout / state code renders correctly in the browser, but native modules
  (camera, sensors, push) are stubbed.
- **Device preview:** the runtime exposes a tunneled Metro URL plus an
  `exp://…` link the user opens in Expo Go.

## Files

- `app/_layout.tsx` — expo-router root layout.
- `app/index.tsx` — home screen.
- `src/` — your code.
- `app.json` — Expo config. Don't change `name` / `slug` casually.
- `babel.config.js` — Expo's Babel preset; required for fast refresh.
- `metro.config.js` — Metro resolver tweaks (e.g. RNW aliasing).

## Conventions

- Use functional components and hooks.
- Use `react-native` primitives (`View`, `Text`, `Pressable`) — not raw
  `div` / `span`.
- Style with the `className` prop and Tailwind utilities (NativeWind is
  pre-configured — see "Styling" below), not `StyleSheet.create`, unless a
  style genuinely needs a dynamic runtime value.
- Prefer the pre-installed UI primitives in `src/components/ui/` (Button,
  Card, Input, Badge, etc.) over hand-rolling the same widgets.
- Navigation is `expo-router` (file-based routes under `app/`).
- Persistent state: `expo-sqlite` or `@react-native-async-storage/async-storage`.

## Styling — NativeWind + UI primitives

The workspace ships with **NativeWind v4** (Tailwind CSS for React Native)
already wired up — Babel, Metro, and `tailwind.config.js` are configured;
no setup is required.

- `global.css` — Tailwind directives + CSS variable color tokens (light
  values in `:root`, dark values under `@media (prefers-color-scheme:
  dark)`). Imported once in `app/_layout.tsx`.
- `tailwind.config.js` — content globs + the color palette (`background`,
  `foreground`, `card`, `primary`, `secondary`, `muted`, `destructive`,
  `border`, `input`, `ring`), each backed by a `--color-*` CSS variable so
  light/dark both work automatically.
- `src/lib/cn.ts` — `cn(...)` class-merging helper (`clsx` + `tailwind-merge`).
- `src/components/ui/` — pre-installed primitives, styled the same way
  shadcn/ui components are on the web tech stack. Import by file, e.g.:

```tsx
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Avatar } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
```

Available today: `Button`, `Card` (+ `CardHeader`/`CardTitle`/
`CardDescription`/`CardContent`/`CardFooter`), `Input`, `Badge`, `Avatar`,
`Separator`, `Switch`, `Progress`, `Skeleton`, `Alert` (+ `AlertTitle`/
`AlertDescription`), `Checkbox`.

**Adding a new primitive** (e.g. `Textarea`, `Select`): create
`src/components/ui/<name>.tsx` following the same pattern as the existing
files — a thin wrapper around a `react-native` primitive that takes
`className`, merges it with variant styles via `cn(...)`, and uses only
the color tokens already defined in `tailwind.config.js` (or new ones you
add there + `global.css`) so dark mode keeps working for free.

## Forbidden commands

- `expo start`, `npx expo start`, `npx react-native start`, `metro` — the
  bundler is owned by PreviewManager.
- `kill`, `pkill` on the bundler process.
- `npm install -g expo-cli` — Expo CLI lives in the project's `node_modules`.

If preview seems stuck, request a rebuild via the runtime's preview/rebuild
endpoint instead of restarting Metro yourself.
