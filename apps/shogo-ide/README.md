# Shogo IDE

This workspace contains the Shogo Code - OSS distribution assets used by the Desktop app.

## What lives here

- `code-oss.lock.json` — the `microsoft/vscode` commit the Shogo IDE server is built from.
- `code-oss-server.manifest.json` — URLs and SHA-256s of the prebuilt server for each desktop target. Written by CI; shipped in the Desktop app.
- `product.shogo.template.json` — Shogo product identity and marketplace/telemetry posture.
- `distribution/` — generated product/default settings applied to the Code - OSS build.
- `extensions/shogo-core/` — bundled Shogo extension that owns the right-side chat webview and context commands.
- `patches/code-oss/` — Shogo changes to Code - OSS, applied at build time.
- `hardening/` — packaging, security, and runtime-readiness metadata.
- `scripts/` — build, validation and materialization helpers.

## How Desktop gets the IDE

Nothing is cloned or built on a user's machine. CI (`.github/workflows/shogo-ide-server.yml`) builds the Code - OSS **REH-web server** for `win32-x64`, `darwin-arm64`, `darwin-x64` and `linux-x64`:

1. Check out the commit pinned in `code-oss.lock.json`.
2. Apply `patches/code-oss/*.patch` and brand `product.json` (`scripts/apply-product-overrides.mjs`).
3. Build `vscode-reh-web-<target>-min`, remove the Copilot extensions, add the built `shogo-core`.
4. Smoke-test the server, pack `<artifactId>-<target>.tar.gz` plus a `.sha256` sidecar, and publish them as a prerelease named after the artifact id.
5. Record the URLs and checksums in `code-oss-server.manifest.json`. On a PR the workflow commits it to the branch; on `main` it opens a PR.

The artifact id is `shogo-ide-server-<commit12>-<inputs12>`, where the inputs hash covers everything baked into the build (`scripts/code-oss-artifact-id.mjs`). An existing release is never rebuilt. `bun scripts/check-shogo-ide-server-manifest.ts` fails when the manifest no longer matches the repo; PR CI runs it offline and desktop releases also check that every asset downloads.

On the first "Open in Shogo IDE", Desktop downloads the asset for its platform, verifies the SHA-256, unpacks it under `%LOCALAPPDATA%\Shogo\ide-server` (Windows), `~/Library/Application Support/Shogo/ide-server` (macOS) or `$XDG_DATA_HOME/shogo/ide-server` (Linux), and runs `node out/server-main.js` with a per-workspace profile and connection token. Later opens reuse the install. Progress and errors go to `<userData>/logs/shogo-ide.log`.

## Changing the server

Edit the patches, `shogo-core`, the product template or the pin, then push: the workflow rebuilds and refreshes the manifest. To bump Code - OSS, change `commit` and `version` in `code-oss.lock.json` and rebase the patches onto the new commit.

To iterate locally, build the server for your platform (needs the checkout's Node version from its `.nvmrc`, Python and a C++ toolchain):

```bash
node apps/shogo-ide/scripts/build-code-oss-server.mjs --target win32-x64 --work <dir> --phase prepare,build,verify
```

then point Desktop at the result instead of the downloaded server:

```bash
SHOGO_IDE_SERVER_DIR=<dir>/vscode-reh-web-win32-x64 bun run --cwd apps/desktop dev
```

Other overrides: `SHOGO_IDE_SERVER_BASE_URL` (download from a mirror; file names and checksums stay the same) and `SHOGO_IDE_SERVER_INSTALL_ROOT` (install somewhere else).

## Code - OSS patches

| Patch | What it does |
| --- | --- |
| `remove-built-in-chat.patch` | Hides the built-in Chat view so Shogo Chat owns the secondary sidebar. |
| `shogo-chat-explorer-drop.patch` | Lets Explorer files/folders (and editor tabs) be dropped on Shogo Chat; the URIs go to `shogo.context.addUris`. Its parser is unit-tested in-repo by `bun test apps/shogo-ide/scripts/__tests__`. |

Both apply to the pinned commit. To apply them to a local checkout by hand:

```bash
bun run --cwd apps/shogo-ide codeoss:patch [<checkout>]
```

## Validation

```bash
bun run --cwd apps/shogo-ide phase1:check
bun run --cwd apps/shogo-ide phase2:check
bun run --cwd apps/shogo-ide phase3:check
bun run --cwd apps/shogo-ide phase4:check
bun run --cwd apps/shogo-ide phase5:check
bun run --cwd apps/shogo-ide phase6:check
bun run --cwd apps/shogo-ide extension:typecheck
bun test apps/shogo-ide/scripts/__tests__
bun scripts/check-shogo-ide-server-manifest.ts --offline
```

## Runtime behavior

Desktop opens Shogo IDE as a managed Code - OSS web workbench. Each Shogo app window and project workspace gets its own IDE window, and each workspace its own server profile under `<userData>/data/shogo-ide/profiles/`.
