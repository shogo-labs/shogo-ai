# Project bucket + CDN — runbook

> **Audience**: an operator applying the SHO-491 infrastructure. The agent never
> applies these; it uses the bucket through `shogo bucket` / `shogo.bucket`.
>
> **What this gives a project**: its own Shogo-hosted object storage
> (`shogo-project-buckets-<env>`) with a CDN in front
> (`https://cdn.<publish_domain>/<projectId>/<key>`), so a project's media lives
> in the bucket instead of in git. 1.76 GB of LFS media committed to a project is
> what forced a hand-grown disk (SHO-478/SHO-485); this is the answer.

## Layout

```
S3_PROJECT_BUCKET
  p/<projectId>/public/<key>    ← served by the CDN, cacheable
  p/<projectId>/private/<key>   ← never served by the CDN; presigned/signed reads only
```

`ProjectBucketObject` (Postgres + the desktop SQLite) is the index: one row per
`(projectId, visibility, key)` with size, content type, etag and sha256. List,
HEAD and usage read the index; only the bytes live in the bucket.

## What Terraform creates

| Resource | Where |
|---|---|
| `oci_objectstorage_bucket.project_buckets` (`shogo-project-buckets-<env>`) | `terraform/modules/object-storage` |
| bucket lifecycle: abort incomplete multipart uploads after 3 days | same |
| read-only, bucket-wide `AnyObjectRead` PAR (`project_buckets`) | same |
| Worker route `cdn.<publish_domain>/*` → `serveProjectBucket` | `terraform/modules/publish-hosting-oci` |
| output `project_buckets_bucket`, `project_buckets_par_base_url`, `project_bucket_cdn_host` | same / `oci-region` |

The bucket has `NoPublicAccess` and versioning **off** (a per-version copy of a
500 MB video is a bill nobody asked for; the index is the source of truth).

## Apply order (staging first)

1. `terraform -chdir=terraform/environments/staging plan` — expect the bucket,
   its lifecycle policy, the PAR, and a Worker script update.
2. `apply`. The PAR is created with `create_before_destroy`; the Worker embeds
   its `access_uri`, so the old Worker keeps serving until the new one lands.
3. Note the outputs:
   ```
   terraform -chdir=terraform/environments/staging output project_buckets_bucket
   terraform -chdir=terraform/environments/staging output project_bucket_origin
   terraform -chdir=terraform/environments/staging output project_bucket_cdn_host
   ```
4. The API pod needs `S3_PROJECT_BUCKET` (`k8s/overlays/<env>/api-service.yaml`,
   already set). `S3_PROJECT_PUBLIC_ENDPOINT` and `SHOGO_BUCKET_CDN_BASE` are
   optional: unset, presigning falls back to the shared public client and the CDN
   base is derived as `https://cdn.<PUBLISH_DOMAIN>`.
5. Roll the API deployment, then verify (below).

## Verify

```bash
# 1) The API can mint a ticket and sees a bucket (not 503 bucket_not_configured)
curl -s -X POST "$API/api/projects/$PROJECT/bucket/uploads" \
  -H 'content-type: application/json' \
  -H "x-runtime-token: $RUNTIME_AUTH_SECRET" -H "x-project-id: $PROJECT" \
  -d '{"key":"smoke/hello.txt","size":5,"contentType":"text/plain","visibility":"public"}'

# 2) The CDN serves it (after the complete call), and refuses a private one
curl -sI "https://cdn.staging.shogo.one/$PROJECT/smoke/hello.txt"   # 200, content-length: 5
curl -sI "https://cdn.staging.shogo.one/$PROJECT/../etc/passwd"     # 404 — traversal refused

# 3) From an agent shell inside a project
shogo bucket usage
shogo bucket put ./README.md --prefix smoke        # prints the CDN URL
shogo bucket ls smoke
shogo bucket url smoke/README.md --private
```

Billing check: after the next storage pass (~6h, or force
`POST /api/admin/storage/recalculate`), `GET /api/projects/<id>/bucket/usage`
should show the bytes under `bucket` in the workspace breakdown, and
`StorageUsageDaily` should carry them.

## Things that will bite you

- **Never widen the Worker's rewrite.** The PAR is bucket-wide because OCI
  pre-authenticated requests cannot be scoped to a prefix. The only thing keeping
  `private/` off the public CDN is `cdnObjectKey`, which rebuilds the key as
  `p/<projectId>/public/<key>` and refuses traversal, dotted ids and empty
  segments. `apps/api/src/__tests__/project-bucket-cdn.test.ts` evaluates the
  Worker's copy out of the Terraform source and fails if the two drift — keep it
  passing rather than editing one side alone.
- **`cdn.` is a Worker route on the publish zone** (`*.${publish_domain}/*`), so a
  `production-eu` overlay with `enable_publish_hosting = false` gets no CDN. The
  bucket still works there; public URLs fall back to the API's redirect route.
- **Eventual consistency on PARs.** OCI's PAR API can 404 for a moment against a
  brand-new bucket; that is why `publish_hosting` `depends_on` the
  object-storage module. Do not remove it.
- **Abandoned uploads.** Multipart uploads that never complete are aborted after
  3 days by the lifecycle rule; the parts otherwise sit in the workspace's
  storage bill.
- **Desktop has no bucket env vars.** `SHOGO_LOCAL_MODE=true` switches to the
  filesystem driver at `<dataDir>/project-buckets/`, served by
  `GET /api/bucket/...` with `Range`. No metering, no gate.

## Rollback

The feature is additive and gated on `S3_PROJECT_BUCKET`:

- Unset `S3_PROJECT_BUCKET` → cloud uploads answer
  `503 bucket_not_configured`, reads 404, metering reports the category as
  unmeasured. Nothing else breaks.
- Desktop is unaffected either way.

Destroying the bucket is a data loss operation: export
`terraform state show module.object_storage.oci_objectstorage_bucket.project_buckets`
first, and tell the affected workspaces (the bytes are their media).

## Related

- SHO-423 — workspace storage metering and the GB-month bill the bucket plugs into
- SHO-478 / SHO-485 — the Samsara incident that motivated this
- `apps/api/src/services/project-bucket.service.ts` — drivers, gate, lifecycle
- `packages/sdk/src/bucket/` and `packages/sdk/bin/bucket-cli.mjs` — the two surfaces
