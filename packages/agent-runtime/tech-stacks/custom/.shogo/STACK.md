# Tech Stack — Custom

## How the preview works

This project brings its own framework. The runtime does not run a dev
server; it runs the project's **build** and serves the output folder as the
preview, rebuilding whenever a source file changes (`node_modules`, `.git`,
`.shogo`, `.astro` and `dist` are ignored).

What it runs:

1. If `shogo.preview.json` exists at the project root, its `build` command
   (default output folder `dist`):

   ```json
   { "build": "bunx @11ty/eleventy --output=_site", "outDir": "_site" }
   ```

2. Otherwise, an Astro project builds with `astro build`.
3. Otherwise, the `build` script in `package.json`, whose output must land in
   `dist/` (or set `outDir` in `shogo.preview.json`).

Dependencies install with `bun install` before the first build.

## Base path

Inside a workspace the preview is served under `/p/<projectId>/`, not `/`.
Astro builds get `--base` automatically. A custom `build` command receives
the base path as `$SHOGO_BASE_PATH`; pass it to your framework's base or
path-prefix option so asset URLs resolve, e.g.
`"build": "vite build --base $SHOGO_BASE_PATH"`. Published sites always
build with `/`.

## Checking a build

- Build output and errors go to the preview build log; read it with the
  runtime log tools when the preview shows a failure.
- Restart the preview to force a clean rebuild.
- The preview only serves static files. Server-side rendering and API routes
  inside the framework do not run here.
