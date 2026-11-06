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
  └─ GET  {pod}/agent/publish-artifact        source + dist/ → tar.gz, base64
  └─ PutObject s3://$PUBLISH_BUCKET/<subdomain>/artifacts/<sha>.tar.gz
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

The artifact excludes `-wal` / `-shm` beside the DB: replaying a write-ahead log
captured mid-write is how a published app starts up with a corrupt table. The
runtime checkpoints first (`PRAGMA wal_checkpoint(TRUNCATE)`), so the image's
`dev.db` is a complete snapshot rather than one that is behind its own last
write.

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
5. The builder image must be rootless BuildKit and its content digest should be
   pinned in `PUBLISH_BUILD_IMAGE` — the Job runs it as-is.

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
