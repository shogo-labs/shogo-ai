# Agent-runtime image size audit

> **Status**: investigation memo for follow-up size-reduction PR. Not a fix.
>
> **Why this exists**: pulled during the 2026-05-20 b11c65dd publish
> incident root-cause. The runtime image is **6.7 GB** (compressed,
> per `kubectl describe pod` on a fresh project pod). On a node with no
> warm cached layer this adds 17–52s to every cold start; on a 99%-full
> node the kubelet can spend several minutes just unpacking layers.
> Smaller image = faster cold start = less warm-pool pressure during
> deploys.

## Layout

[`packages/agent-runtime/Dockerfile`](../packages/agent-runtime/Dockerfile)
layers a pre-baked `WORKSPACE_DEPS` image (containing `node_modules` and
all built packages) on top of [`Dockerfile.base`](../packages/agent-runtime/Dockerfile.base)
(system packages: chromium, ffmpeg, ripgrep, AWS CLI, GitHub CLI, etc).

## Suspected fat — to confirm with `du -sh node_modules/*` inside the image

1. **Workspace package.json stubs include desktop + mobile**, dragging in
   transitive Electron / React Native deps the cloud runtime never uses:

   ```62:63:packages/agent-runtime/Dockerfile
   COPY --from=workspace --parents /app/./packages/*/package.json ./
   COPY --from=workspace --parents /app/./apps/*/package.json ./
   ```

   The follow-up `bun install --ignore-scripts` walks the workspace
   graph; missing package.jsons fail with `Workspace dependency not
   found`. Solution: trim the copy glob to exclude `apps/desktop` and
   `apps/mobile`, or stub them out with a minimal `{ "name": ... }` so
   bun's resolver is happy without pulling deps.

2. **`@aws-sdk/*` is heavy.** s3-sync only uses `@aws-sdk/client-s3`
   plus a couple of commands; modular sub-imports drop dozens of MB.

3. **Playwright bundles its own browser binary.** `Dockerfile.base`
   uses system Chromium and sets `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`,
   but if any transitive package pulls Playwright as a dep with the
   download default, those binaries land in `node_modules`.

4. **Pre-built dist/ for templates.** `templates/runtime-template`
   ships ~3 build outputs (Astro, Vite, Next). Verify `bun run
   build-template-dists` prunes its source `.next/cache/` before the
   workspace-deps image is cut.

## Action plan (separate PR)

Goal: get the image under 3 GB.

1. Cut a one-off CI run that emits `du -sh /app/node_modules/* | sort
   -rh | head -50` and `find /app -type f -size +20M` into the build
   logs.
2. Drop `apps/desktop`, `apps/mobile`, `apps/docs` from the workspace
   stubs in [`packages/agent-runtime/Dockerfile`](../packages/agent-runtime/Dockerfile).
3. Audit `packages/agent-runtime/package.json` for `@aws-sdk/*`
   barrel imports — switch to `@aws-sdk/client-s3` only.
4. Verify Playwright not pulled transitively (it sometimes ships a
   browser even when the host opts out).

Expected combined wins: 6.7 GB → ~2.5 GB image, ~5–10s reduction in
warm-up pull time on a cold node, and ~30 GB less ephemeral-storage
churn per warm-pool churn cycle (matters because OKE node disks fill).
