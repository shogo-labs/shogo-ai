# Building Shogo for macOS (ARM / Intel)

## Prerequisites

- **macOS** with Xcode Command Line Tools (`xcode-select --install`)
- **Bun** >= 1.3 (`curl -fsSL https://bun.sh/install | bash`)
- **Node.js** >= 20 (for Expo CLI and Electron)
- **Apple Developer ID Certificate** installed in Keychain (for signing)
- **App-specific password** generated at https://appleid.apple.com (for notarization)
- Monorepo dependencies installed: `bun install` from repo root

## Environment Variables

Create `.env.local` in the **repo root** with your signing credentials:

```bash
APPLE_ID=you@example.com
APPLE_ID_PASSWORD=xxxx-xxxx-xxxx-xxxx   # App-specific password, NOT your account password
APPLE_TEAM_ID=XXXXXXXXXX                # Your 10-char Apple Developer Team ID
```

These are read by `forge.config.ts` to enable `osxSign` + `osxNotarize`.
If these are not set, the app builds unsigned (fine for local dev, won't run on other Macs).

## Build Steps

All commands run from the **repo root** (`/path/to/shogo-ai`).

### 1. Source signing credentials

```bash
source .env.local
```

### 2. Download the bundled Bun binary

Downloads the latest Bun release for the target platform into `apps/desktop/resources/bun/`.
Skips if already present — delete the directory to force a re-download.

```bash
# Force fresh download (recommended before a release):
rm -rf apps/desktop/resources/bun
node apps/desktop/scripts/download-bun.mjs
```

### 3. Export the Expo web build

Builds the React Native web frontend with local-mode flags:

```bash
cd apps/mobile
EXPO_PUBLIC_LOCAL_MODE=true EXPO_PUBLIC_API_URL=http://localhost:39100 npx expo export --platform web
cd ../..
```

Then copy it into desktop resources:

```bash
rm -rf apps/desktop/resources/web
cp -R apps/mobile/dist apps/desktop/resources/web
```

### 4. Bundle the API server

Compiles the API server, agent-runtime, and MCP server into single JS files,
installs native dependencies (Prisma, sqlite-vec, etc.), builds canvas-runtime,
and copies templates:

```bash
# Clean stale artifacts first (handles ENOTEMPTY errors):
rm -rf apps/desktop/resources/{node_modules,bundle,canvas-runtime,templates,runtime-template}

node apps/desktop/scripts/bundle-api.mjs
```

### 5. Compile the Electron TypeScript

```bash
cd apps/desktop
npx tsc --noEmit false --outDir dist
cd ../..
```

### 6. Build the signed DMG

```bash
cd apps/desktop
bun run make
cd ../..
```

Output artifacts land in `apps/desktop/out/make/` (`.dmg` for macOS).

The unsigned `.app` bundle is at `apps/desktop/out/Shogo-darwin-arm64/Shogo.app`.

## Quick One-Liner

```bash
source .env.local \
  && rm -rf apps/desktop/resources/bun && node apps/desktop/scripts/download-bun.mjs \
  && (cd apps/mobile && EXPO_PUBLIC_LOCAL_MODE=true EXPO_PUBLIC_API_URL=http://localhost:39100 npx expo export --platform web) \
  && rm -rf apps/desktop/resources/web && cp -R apps/mobile/dist apps/desktop/resources/web \
  && rm -rf apps/desktop/resources/{node_modules,bundle,canvas-runtime,templates,runtime-template} \
  && node apps/desktop/scripts/bundle-api.mjs \
  && (cd apps/desktop && npx tsc --noEmit false --outDir dist && bun run make)
```

## Installing the Built App

```bash
# Remove old version and quarantine flag
rm -rf /Applications/Shogo.app
cp -R apps/desktop/out/Shogo-darwin-arm64/Shogo.app /Applications/
xattr -d com.apple.quarantine /Applications/Shogo.app 2>/dev/null
```

## What the Build Produces

```
Shogo.app/Contents/
├── MacOS/Shogo              # Electron binary
├── Resources/
│   ├── app.asar             # Electron main/preload (from dist/)
│   ├── bun/bun              # Bundled Bun runtime
│   ├── web/                 # Expo web export (served via shogo:// protocol)
│   ├── bundle/              # Compiled JS entry points
│   │   ├── api.js           # API server (~15 MB)
│   │   ├── agent-runtime.js # Agent runtime (~22 MB)
│   │   └── mcp-server.js    # MCP server (~56 KB)
│   ├── node_modules/        # Native packages (Prisma, sqlite-vec, etc.)
│   ├── canvas-runtime/      # Canvas v2 code-mode SPA + type definitions
│   ├── templates/           # Agent project templates (17 templates)
│   ├── runtime-template/    # Vite scaffold for new projects
│   ├── seed.db              # Initial SQLite database
│   ├── prisma/              # Schema + migrations
│   └── prisma.config.js     # Prisma config for local SQLite
└── entitlements.plist        # Hardened runtime entitlements
```

## Troubleshooting

**`ENOTEMPTY: directory not empty` during bundle**
Run `rm -rf apps/desktop/resources/{node_modules,bundle}` before `bundle-api.mjs`.

**Code signature broken after first launch**
The app must not write to its own bundle. All runtime data goes to
`~/Library/Application Support/Shogo/data/`. If Prisma engines are
writing inside the bundle, check that `PRISMA_SCHEMA_ENGINE_BINARY` is set
to a writable location (handled automatically by `local-server.ts`).

**Prisma Node version check fails during `bun install` in project**
The bundled Bun binary is too old. Delete `apps/desktop/resources/bun/` and
re-run `download-bun.mjs` to get the latest version.

**`ERR_BLOCKED_BY_CSP` for canvas iframe**
The Electron CSP in `main.ts` needs `frame-src` for `http://localhost:*`.

**App crashes immediately on double-click**
Launch from terminal to see output:
```bash
/Applications/Shogo.app/Contents/MacOS/Shogo
```
Logs are also written to `~/Library/Logs/Shogo/main.log`.

**`Error: P3005 — The database schema is not empty` on startup (legacy installs)**
Affects installs from versions ≤1.3.3 that first-ran on a machine without
`sqlite3` on PATH (notably stock Windows). The seed database was copied but
`_prisma_migrations` was never populated, so every subsequent launch tried
to re-apply migrations against tables that already existed.

Modern builds detect this automatically: `runMigrations` in
`apps/desktop/src/local-server.ts` catches P3005, baselines the existing
database via `bun:sqlite`, and retries once. No user action required —
simply re-launch the app.

If for some reason the self-heal doesn't run (e.g. you're pinned to an old
build), baseline manually with the bundled `bun`:

```bash
# Windows (adjust paths for your install):
"%LOCALAPPDATA%\Shogo\app-1.3.3\resources\bun\bun.exe" -e "const {Database}=require('bun:sqlite');const {randomUUID}=require('node:crypto');const db=new Database(process.argv[1]);db.exec('CREATE TABLE IF NOT EXISTS \"_prisma_migrations\" (\"id\" TEXT PRIMARY KEY NOT NULL,\"checksum\" TEXT NOT NULL,\"finished_at\" DATETIME,\"migration_name\" TEXT NOT NULL,\"logs\" TEXT,\"rolled_back_at\" DATETIME,\"started_at\" DATETIME NOT NULL DEFAULT current_timestamp,\"applied_steps_count\" INTEGER NOT NULL DEFAULT 0)');const existing=new Set(db.query('SELECT migration_name FROM _prisma_migrations').all().map(r=>r.migration_name));const stmt=db.prepare('INSERT INTO _prisma_migrations (id,checksum,finished_at,migration_name,applied_steps_count,started_at) VALUES (?,?,?,?,1,?)');const now=new Date().toISOString();for (const n of process.argv.slice(2)) if (!existing.has(n)) stmt.run(randomUUID(),'baseline-seed',now,n,now);" "%APPDATA%\Shogo\data\shogo.db" 0000_baseline 0001_add_project_last_message_at 0002_add_missing_models 0003_add_capacity_tiers_and_storage 0005_add_meetings
```
