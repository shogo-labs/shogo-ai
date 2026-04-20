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

**Windows: "trouble starting your project environment" (agent gateway never starts, EPERM rename)**
Seen in `%APPDATA%\Shogo\logs\main.log` as:

```
[Agent:<id>] Initialization failed: ... EPERM: operation not permitted, rename
'...\workspaces\<id>\src' -> '...\workspaces\<id>\project\src'
```

On first run for a new project, `ensureWorkspaceFiles` in
`packages/agent-runtime/src/server.ts` migrates the workspace into a nested
`project/` subdirectory when it detects a "legacy APP layout" (a `package.json`
at workspace root with no `AGENTS.md` beside it). POSIX `rename(2)` succeeds
even while another process is watching the source tree; NTFS does not, so the
migration fails as soon as Vite's file watcher — spawned concurrently by the
host `RuntimeManager` — has `src/` open. The agent-runtime process then exits
and every chat request gets `503 Agent gateway not running`.

Modern builds avoid this in two ways: the runtime template now ships an
`AGENTS.md` at root (see `templates/runtime-template/AGENTS.md`), and
`ensureRuntimeTemplate` in `apps/desktop/src/local-server.ts` self-heals
pre-existing `_template/` dirs by copying it in. The migration code in
`server.ts` also falls back to `cpSync` + retrying `rmSync` on `EPERM`/`EBUSY`
so the rename still lands eventually.

If you're stuck on an older build and hit this, recover by quitting Shogo
and creating the marker by hand:

```powershell
# 1. Stop Shogo from the tray and confirm no stray bun.exe/Shogo.exe are left
Get-Process | Where-Object { $_.Name -match '^(Shogo|bun)$' } | Stop-Process -Force

# 2. Seed AGENTS.md in the shared template (future projects)
@"
# Identity

- **Name:** Shogo
"@ | Set-Content "$env:APPDATA\Shogo\data\workspaces\_template\AGENTS.md"

# 3. For each half-migrated project workspace, move project\* back to root,
#    remove project\, and drop in AGENTS.md
```

**Windows: "trouble starting your project environment" / `VM warm pool disabled after N consecutive boot failures`**
QEMU + WHPX cannot boot an agent VM on this host (the VM usually dies at
iPXE after emitting `whpx: injection failed, MSI (0, 0) delivery: 0 …
(c0350005)` — a known Hyper-V/WHPX interrupt-delivery quirk on some Windows
installs). After `MAX_CONSECUTIVE_FAILURES` (3) failed VM boots the warm pool
permanently disables itself for the session.

Modern builds detect this and fall back to the host `RuntimeManager` (see
`VMPoolPermanentlyDisabledError` in
`apps/api/src/lib/vm-warm-pool-controller.ts`), so the user gets a working
runtime instead of a cryptic `pod_unavailable`. To silence the warning and
skip the wasted VM boot attempts on subsequent launches, write:

```json
{ "vmIsolation": { "enabled": false } }
```

into `%APPDATA%\Shogo\config.json`. See `apps/desktop/src/config.ts` for the
full schema — the `'auto'` default still attempts VM isolation whenever QEMU +
a provisioned rootfs are present.

**Windows: "trouble starting your project environment" / `'npm.cmd' is not recognized`**
Shogo Desktop on Windows requires **Node.js 20+** to be installed at the
standard location (`C:\Program Files\nodejs\`). Bun 1.x has a hardlink bug on
Windows that produces empty `node_modules` stubs, so `RuntimeManager` (see
`packages/shared-runtime/src/platform-pkg.ts`) shells out to `npm.cmd` for
project dependency installs. Without Node.js the install step fails and the
UI shows the generic "We're having trouble starting your project environment"
error.

Install the latest Node.js LTS from https://nodejs.org/ (or
`winget install OpenJS.NodeJS.LTS`) and restart Shogo. The app logs a clear
warning at startup when this prerequisite is missing — check
`%APPDATA%\Shogo\logs\main.log` for
`[Desktop] WARNING: Node.js is not installed` to confirm.

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
