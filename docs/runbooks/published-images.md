# Per-commit published images

SHO-308 §2. A server-backed published app runs an image that was built **once,
per commit**, at publish time — not a container that installs and builds on
every boot.

Why: the published pod used to hydrate source and then run `bun install`,
`prisma generate` and a Vite build before it could answer a request. Every
replica and every cold start after scale-to-zero paid that. Moving the build to
publish time is what makes autoscaling and scale-to-zero viable.

## The flow

```
POST /projects/:id/publish
  └─ POST {pod}/agent/publish-build           root-based dist/ (base "/")
  └─ GET  {pod}/agent/publish-artifact?bucket=…&key=…
        source + dist/ → tar.gz, LARGE MEDIA REPLACED BY LFS POINTERS
        the runtime uploads the tar to <bucket>/<key> itself and answers
        { key, bytes } — the archive never crosses the API (SHO-485)
  └─ presign GET s3://$PUBLISH_BUCKET/<subdomain>/artifacts/<sha>.tar.gz
  └─ Job shogo-builds/published-build-<project8>-<sha10>
        init: fetch artifact → /src, write the platform Dockerfile
        build: buildkit → push <registry>/<ns>/shogo/published/<project>:<sha>
                --metadata-file /dev/termination-log   (returns the digest)
  └─ PublishedDeployment { imageRef: <repo>@sha256:…, imageDigest: sha256:… }
  └─ ksvc  image: <repo>@sha256:… , imagePullPolicy: IfNotPresent
```

A re-publish of a commit already recorded reuses its digest (`reused: true`,
no Job). Rollback, redeploy and promote patch the ksvc to the **recorded
digest** — a tag could have been moved onto a different commit; a digest cannot.

Boot with `SHOGO_PREBUILT_IMAGE=true` (set by the generated Dockerfile) skips
install / prisma / build-watch in the runtime: the image carries `node_modules`,
the generated Prisma client and `dist/`, so boot is `bun server.tsx`.

## What the image is, and what it is not

| Layer | Carried by | Changes when |
| --- | --- | --- |
| Source at the commit | the image | the commit changes |
| `node_modules` + generated Prisma client | the image (`bun install`, `prisma generate`) | the commit changes |
| Root-based `dist/` | the image (the runtime's publish build) | the commit changes |
| Seed DB (`prisma/dev.db`) | the image | the commit changes |
| What end users have written since | durable overlay (`PublishedDataSync`) | every request |

So the boot path does **not** install, generate, build, or restore the durable
git repo: restoring it would overwrite the baked source and pay a clone on every
cold start. `publishedBootPlan()` is the single place that decides this — the
source hydration in `initializePublished()` and the install/generate/watch step
in `backgroundSetup()` both read it. The writable-state overlay still runs, so
the image is the commit and the overlay is the data.

## Media does not travel in the image (SHO-485)

A published pod's volume is a 2 Gi `emptyDir`, so the boot path must not depend
on how much media the project has. Two rules make that true:

1. **The artifact carries pointers, not media.** Every LFS-tracked source file
   and every `dist/` file ≥ 5 MiB (`PUBLISH_DIST_OFFLOAD_MIN_BYTES`) is
   content-addressed into `<projectId>/lfs/objects/<sha256>` and replaced by
   pointer text. A pointer whose object cannot be stored fails the publish with
   `lfs_object_missing` — a pointer is never shipped without its bytes.
2. **The pod serves those bytes on request.** `serveDistResponse` sees a pointer
   under `dist/`, streams the object from the object store (`GET`, `Range`,
   `HEAD`, `If-None-Match` → `304`), and never materializes it. `publishedBootPlan().materializeLfs`
   is `false` on an image boot for the same reason.

So neither the image, the build Job's 2 Gi `src` volume, nor the pod's disk
grows with the project's media. An artifact over `PUBLISH_ARTIFACT_MAX_BYTES`
(default 1536 MB) is refused as `artifact_too_large` before a Job is created.

**Known limitation:** app server code that `fs.read`s an LFS-tracked file
*outside* `dist/` on an image-booted pod gets pointer text. Static serving and
everything under `dist/` are covered; server-side file reads are not.

The artifact excludes `-wal` / `-shm` beside the DB: replaying a write-ahead log
captured mid-write is how a published app starts up with a corrupt table. The
runtime checkpoints first (`PRAGMA wal_checkpoint(TRUNCATE)`), so the image's
`dev.db` is a complete snapshot rather than one that is behind its own last
write.

**The project's own `.dockerignore` is honoured** (SHO-514). The context is built
by Docker (`COPY . /app`), so the file a project already maintains applies — one
direction only: it can remove paths, never bring back `.env*`, `.git/`,
`node_modules`, `.shogo` or `-wal/-shm`, and never drop `package.json`, the
lockfile, `prisma/schema.prisma` or `prisma/dev.db` — including when a rule matches
the `prisma/` directory itself (`*`, `pr*`, an allowlist), since a pruned directory
takes its required files with it. A blanket `*` rule therefore cannot produce an
image without a schema. `.dockerignore` itself is not copied into the context
(BuildKit would apply it a second time to the platform-added files). The publish
output logs `N paths / X MB left out by .dockerignore`.

So for big media there are two answers, and they are different: committed media
belongs in LFS (pointers, above), and anything the app does not need at runtime —
renders, raw footage, scratch output — belongs in `.dockerignore` or in the
project bucket, not in the image.

## Cluster prerequisites

These are per region and must exist **before** enabling the feature.
`k8s/published-builds/builds.yaml` declares items 1–2 plus a `LimitRange` /
`ResourceQuota` (so a runaway build cannot evict a published pod); items 3–4 are
manual.

1. Namespace `shogo-builds` (or `PUBLISH_BUILD_K8S_NAMESPACE`).
2. ServiceAccount `shogo-builds` in that namespace — the Job does not talk to
   the API, so it needs no RBAC beyond running a Pod.
3. Push credentials as a `kubernetes.io/dockerconfigjson` Secret named
   `ocir-push` (or `PUBLISH_BUILD_REGISTRY_SECRET`) in that namespace, with
   `key: .dockerconfigjson`. The Job mounts it at `/home/user/.docker/config.json`:

   ```sh
   kubectl -n shogo-builds create secret docker-registry ocir-push \
     --docker-server=us-ashburn-1.ocir.io \
     --docker-username='<tenancy>/<user>' \
     --docker-password='<auth-token>'
   ```
4. Network egress from the namespace to OCIR and to the S3 endpoint that the
   presigned artifact URL points at (the API signs with the **internal** client,
   so a Job in-cluster never needs the public endpoint).
5. The builder image must be rootless BuildKit, **fully qualified**
   (`docker.io/moby/buildkit:v0.18.2-rootless` on staging), and its content
   digest should be pinned in `PUBLISH_BUILD_IMAGE` — the Job runs it as-is.
   OKE's CRI-O enforces short names, so `moby/buildkit:…` never leaves
   `ImageInspectError`.
6. `ocir-push` can be a copy of the region's `ocir-pull-secret` (its OCIR user
   can push; OCIR creates `shogo/published/<projectId>` on first push):
   `kubectl -n shogo-staging-workspaces get secret ocir-pull-secret -o json | jq '{apiVersion,kind,type,data,metadata:{name:"ocir-push",namespace:"shogo-builds"}}' | kubectl apply -f -`

## Turning it on in US and EU production (SHO-485 §3)

The variables are already in `k8s/overlays/production-us/api-service.yaml` and
`production-eu/api-service.yaml`, and both overlays include
`../../published-builds` (namespace, ServiceAccount, LimitRange, ResourceQuota).
**Two prerequisites are manual operator steps per region — the repo cannot
create a credential.** Do not enable a region until both are done.

### 1. The OCIR push Secret (per region, manual)

The Secret is deliberately not declared in git — applying a placeholder would
overwrite real credentials. Either copy the region's pull secret (its OCIR user
can push, and OCIR creates `shogo/published/<projectId>` on first push):

```sh
# Run against the region's cluster (US: us-ashburn-1, EU: eu-frankfurt-1).
# Both regions name the workspaces namespace the same; the Secret differs per
# cluster because its docker-server is that region's OCIR host.
kubectl -n shogo-production-workspaces get secret ocir-pull-secret -o json \
  | jq '{apiVersion,kind,type,data,metadata:{name:"ocir-push",namespace:"shogo-builds"}}' \
  | kubectl apply -f -
```

or create one with a dedicated auth token:

```sh
kubectl -n shogo-builds create secret docker-registry ocir-push \
  --docker-server=us-ashburn-1.ocir.io \
  --docker-username='<tenancy>/<user>' \
  --docker-password='<auth-token>'
```

`--docker-server` must match that region's OCIR host
(`us-ashburn-1.ocir.io` / `eu-frankfurt-1.ocir.io`).

### 2. Egress from `shogo-builds` (per region, manual)

The Job's init container fetches the artifact through a **presigned internal**
URL and BuildKit pushes to OCIR. Whatever network policy the region applies must
allow `shogo-builds` → the internal S3 endpoint and `shogo-builds` → that
region's OCIR host on 443. Nothing else: the Job has no API access and no
cluster credentials.

### 3. Verify, then let the deploy set the variables

```sh
kubectl -n shogo-builds get ns,sa,limitrange,resourcequota
kubectl -n shogo-builds get secret ocir-push
kubectl -n shogo-production-system get deploy shogo-api \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PUBLISH_BUILD_REGISTRY")].value}{"\n"}'
```

`k8s/overlays/production-us` and `production-eu` render the three variables with
their own OCIR host; a deploy applies them. Publish one small server app in each
region and confirm the card reaches *PR Open* with an `imageRef` digest, then
cold-start it once.

### Rolling back a region

`PUBLISH_BUILD_IMAGES=off` on that region's API, then redeploy — no unsets, and
revisions already running a digest keep running. Existing per-commit images stay
pullable; new publishes go back to the shared `RUNTIME_IMAGE` (source hydrate,
which still materializes LFS bytes). Delete the `ocir-push` Secret only if the
feature is being abandoned — jobs for commits already built will keep working
until their image is garbage-collected by the OCIR retention policy.

## Enabling, and rolling back

| Variable | Meaning |
| --- | --- |
| `PUBLISH_BUILD_REGISTRY` | OCIR host, e.g. `us-ashburn-1.ocir.io` |
| `PUBLISH_BUILD_NAMESPACE` | tenancy namespace, e.g. `ax9example` |
| `PUBLISH_BUILD_IMAGE` | rootless BuildKit image |
| `PUBLISH_BUILD_K8S_NAMESPACE` | cluster namespace (default `shogo-builds`) |
| `PUBLISH_BUILD_REGISTRY_SECRET` | docker-config Secret (default `ocir-push`) |
| `PUBLISH_BUILD_TIMEOUT_MS` | API wait per build (default 900000) |
| `PUBLISH_BUILD_POLL_MS` | Job poll interval (default 3000) |
| `PUBLISH_BUILD_IMAGES` | `on` forces (a bad config fails publishes), `off` disables |
| `PUBLISH_ARTIFACT_MAX_BYTES` | build-context ceiling, refused as `artifact_too_large` (default 1536 MB) |
| `PUBLISH_ARTIFACT_UPLOAD_TIMEOUT_MS` | how long the API waits for the runtime to hash + upload the context (default 1200000) |

The gate mirrors Postgres-at-publish: **with the three required variables
unset, publishing behaves exactly as it does today** and every environment boots
the shared `RUNTIME_IMAGE`. A region rolls back by setting
`PUBLISH_BUILD_IMAGES=off` — no unsetting, and existing digest-pinned revisions
keep running.

`PUBLISH_BUILD_IMAGES=on` is the deliberate strict mode: a publish that cannot
produce an image then **fails** (`build_failed` / `build_timeout` /
`build_digest_missing`, with the build's log tail in `publishError`) rather than
silently serving the shared image with the wrong commit in it.

## Failure codes

| Code | Meaning | What to check |
| --- | --- | --- |
| `build_not_configured` | required env missing (only reachable with `PUBLISH_BUILD_IMAGES=on`) | the table above |
| `artifact_missing` | the editing runtime could not produce source + `dist/` | `/agent/publish-build` log in the runtime |
| `artifact_too_large` | the build context exceeds `PUBLISH_ARTIFACT_MAX_BYTES` (1536 MB) | what is in the context — with media excluded this means something else is bloated |
| `lfs_object_missing` | a media file could not be made durable in `<projectId>/lfs/objects` | object-store credentials/egress from the **editing** runtime |
| `build_failed` | BuildKit Job exited non-zero | `publishError` carries the last 12 lines of the pod log |
| `build_timeout` | no result within `PUBLISH_BUILD_TIMEOUT_MS` | Job duration, node capacity, registry push speed |
| `build_digest_missing` | the build finished but reported no digest | `/dev/termination-log` was truncated or not JSON; look at the job's pod |

Investigate with:

```sh
kubectl -n shogo-builds get jobs
kubectl -n shogo-builds logs job/published-build-<project8>-<sha10>
kubectl -n shogo-builds get job published-build-<project8>-<sha10> \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.message}{"\n"}{end}'
```

Failed and timed-out Jobs are deleted by the API after the tail is captured; a
Job is `ttlSecondsAfterFinished: 3600`, so a successful one lingers an hour at
most.

## Cost

One build per commit, not per publish or per boot. The Job requests `500m` /
`1Gi` (limits `2` CPU / `4Gi`); the image build itself is a `bun install` plus a
`prisma generate` — the `vite build` already ran in the editing runtime to
produce the root-based `dist/` that travels in the artifact. Re-publishing the
same commit is free.
