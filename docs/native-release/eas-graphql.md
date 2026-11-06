# EAS GraphQL: what we can and cannot do without a browser

Status: **Phase 0 spike complete (SHO-323)**, probed against the live schema at
`https://api.expo.dev/graphql` on 2026-11-04. Re-run
`bun scripts/native-release-graphql-introspect.ts` to reproduce every claim here.

The schema endpoint answers **unauthenticated introspection**, so everything below was
read from the real, current schema rather than from documentation. Nothing was mutated:
no org, project, robot or token was created during the spike.

## Result in one line

Everything the plan needs exists as a public mutation **except creating a new Expo
organisation** — and, because of that gap, the token does not have to live in the
runtime at all: EAS accepts an **uploaded project archive**, so the cloud can create
every build and workflow run itself while the runner stays token-less.

## Confirmed mutations

```graphql
# A robot user on an account, with one Permission, returning the Robot.
mutation {
  robot {
    createRobotForAccount(
      accountID: "<account id>"
      robotData: { name: "shogo-<workspaceShortId>" }
      permissions: PUBLISH          # Permission: OWN | ADMIN | PUBLISH_PROTECTED | PUBLISH | RUN | VIEW
    ) { id displayName }
  }
}

# A token for that robot. Returns the secret exactly once.
mutation {
  accessToken {
    createAccessToken(
      createAccessTokenData: { actorID: "<robot id>", note: "shogo workspace <id>", scopes: [...] }
    ) { token accessToken { id note } }
  }
}
# rotate/revoke: accessToken.setAccessTokenRevoked(id, revoked)  ·  accessToken.deleteAccessToken(id)

# The EAS project for one Shogo project. `appInput.accountId` may be an org id.
mutation {
  app {
    createApp(appInput: { accountId: "<org id>", projectName: "shogo-<projectSlug>" }) { id slug }
  }
}

# The per-project webhook that later meters the build.
mutation {
  webhook {
    createWebhook(
      appId: "<app id>"
      webhookInput: { url: "https://api.shogo.ai/api/webhooks/eas?event=build", secret: "<32B hex>", event: BUILD }
    ) { id }
  }
}
# event is WebhookType: BUILD | SUBMIT — which webhook you subscribe to, NOT a
# field in the delivered body. Register two, each with its own `?event=` query:
# see "The webhook body" below.

# Signed upload slots. Called by the CLOUD, never by the runner.
#
# Two different mutations, and only these two: project sources are NOT app-scoped.
mutation {
  uploadSession {
    # Unscoped, for a build's source archive and its metadata.
    createUploadSession(
      type: EAS_BUILD_GCS_PROJECT_SOURCES   # UploadSessionType
      filename: "project.tar.gz"
    ) { url bucketKey }
  }
}
mutation {
  uploadSession {
    # Account-scoped, the only route to a workflow's project source.
    createAccountScopedUploadSession(
      type: WORKFLOWS_PROJECT_SOURCES       # AccountUploadSessionType
      accountID: "<org id>"
    ) { url bucketKey }
  }
}

# Start the build from an archive the runner already uploaded — no token at the runner.
mutation {
  build {
    createIosBuild(
      appId: "<app id>"
      job: { ...eas-build-job JSON... }
      # Every BuildMetadataInput field is optional. Do NOT put the source
      # archive's bucketKey in `projectMetadataFile`: that field is a JSON file
      # uploaded through its own EAS_BUILD_GCS_PROJECT_METADATA session, so a
      # tarball key there fails the build. Omit it; send `fingerprintHash`.
      metadata: { fingerprintHash: "<sha>" }
      buildParams: { resourceClass: IOS_MEDIUM, expoTokenRole: RUNNER }   # BuildResourceClass, not DEFAULT|MEDIUM|LARGE
    ) { id status }
  }
}
# createAndroidBuild takes the same shape.

# Run a workflow (build -> Maestro -> submit) from the same archive.
mutation {
  workflowRun {
    createWorkflowRun(
      appId: "<app id>"
      workflowRevisionInput: { fileName: ".eas/workflows/release.yml", yamlConfig: "<the yaml>" }
      workflowRunInput: {
        projectSource: { type: GCS, projectArchiveBucketKey: "<key>", easJsonBucketKey: "<key>", packageJsonBucketKey: "<key>" }
      }
    ) { id status }
  }
}

# Submissions, when they are not part of a workflow.
submission { createIosSubmission(input: {...}) { id } }
submission { createAndroidSubmission(input: {...}) { id } }
```

`ProjectArchiveSourceType` is `URL | GCS | NONE | GIT`, and
`WorkflowProjectSourceInput.projectArchiveBucketKey` means **EAS Workflows do not
require a git remote** — an uploaded archive is enough.

## Two calls that look right and are not

Recorded because both were in this document's first draft and both pass any check that
only looks for a name:

- **`uploadSession.createAppScopedUploadSession` cannot upload source.** Its `type` is
  `AppUploadSessionType`, whose only value is `PROFILE_IMAGE_UPLOAD`. Project sources go
  through the *unscoped* `createUploadSession(type: EAS_BUILD_GCS_PROJECT_SOURCES |
  EAS_BUILD_GCS_PROJECT_METADATA | EAS_SUBMIT_GCS_APP_ARCHIVE)`; workflow sources through
  the *account*-scoped `createAccountScopedUploadSession(type:
  WORKFLOWS_PROJECT_SOURCES)`.
- **`resourceClass` is not `DEFAULT | MEDIUM | LARGE`.** It is `BuildResourceClass`, one
  enum across both platforms with the platform in the name — see below. `BuildParamsInput`
  and the value the build webhook reports both use it.

## Resource classes are the price list

`BuildResourceClass` is a single enum: `ANDROID_DEFAULT | ANDROID_MEDIUM | ANDROID_LARGE |
IOS_DEFAULT | IOS_MEDIUM | IOS_LARGE | IOS_M_MEDIUM | IOS_M_LARGE | LEGACY | LINUX_MEDIUM |
LINUX_LARGE`. The webhook reports exactly one of these per `finished`/`errored` build, so
**the meter's table is keyed by this enum and must have a row for every value it can
receive** — an unknown class has to fail loudly rather than silently price at `medium`.

Published flat rates ([expo.dev/pricing.md](https://expo.dev/pricing.md), read 2026-11-04):

| Platform | Worker | Per build |
| --- | --- | --- |
| Android | medium | $1 |
| Android | large | $2 |
| iOS | medium | $2 |
| iOS | large | $4 |

Note what that table does **not** cover: the plan's `$2`/`$4` for iOS are the medium and
large rows only, while the schema exposes **four** billable iOS classes —
`IOS_MEDIUM`, `IOS_LARGE`, `IOS_M_MEDIUM`, `IOS_M_LARGE` — plus `IOS_DEFAULT`. The `M_`
variants are the Apple-silicon workers; Expo's public rate card does not price them, so
either the meter refuses them (with a clear error, not a guess) or Expo confirms their
rate first. This is Phase 1 work, not a detail: `IOS_M_*` is what a large RN project is
pushed onto.

Two other numbers from the same page matter to the tenancy choice: **projects per
account** are 25 (Free) / 50 (Starter) / 100 (Production) / 300 (Enterprise), and build
jobs are a **flat rate per build**, not per minute — so `native_build` is one price per
build id, while Maestro/CI jobs are $0.05 per run plus CI minutes ($0.018/min Linux
medium, $0.075/min macOS medium).

## The one thing that does not exist

There is **no mutation that creates an Expo organisation.** The root mutation list has
`account(accountName:)` (a per-account mutation namespace), `robot`, `accessToken`,
`webhook`, `app`, `build`, `submission`, `workflowRun`, `uploadSession` — and
`AccountMutation` only ever operates on an account id that already exists
(`rename`, `grantActorPermissions`, `changePlan`, …). `Account` does expose
`ownerUserActor`, so organisation accounts are first-class in the model; they are just
not creatable through the public API.

**Consequence:** the plan's "one Expo organisation per Shogo workspace, created lazily
on the first native release" cannot be implemented as written. Either Expo opens an
org-creation path for us (Phase 0 question 1), Expos's orgs are provisioned out of band
by ops, or the tenancy model changes. See [Options](#options) below.

## The robot role is `Permission`, not `Role`

`createRobotForAccount` takes `Permission` (`OWN | ADMIN | PUBLISH_PROTECTED |
PUBLISH | RUN | VIEW`). The dashboard's `Role` enum (`OWNER | ADMIN |
RELEASE_MANAGER | DEVELOPER | RUNNER | VIEW_ONLY | CUSTOM`) is a **different** enum and
is not accepted here. The plan's "role `Developer`" therefore maps to a
`Permission` we have to choose at spike time: `PUBLISH` is the lowest level that both
builds and submits; `PUBLISH_PROTECTED` cannot publish without additional approval.
Whatever we pick has to be recorded, because it is the blast radius of a leaked
workspace token.

## The ASC 401 regression is real, and there is no clean version to pin

`eas build -p ios` fails during "Linking bundle identifier" with an Apple 401 when an
App Store Connect **team** API key is provided through `EXPO_ASC_API_KEY_PATH` /
`EXPO_ASC_KEY_ID` / `EXPO_ASC_ISSUER_ID` / `EXPO_APPLE_TEAM_ID`
([expo/eas-cli#4623](https://github.com/expo/eas-cli/issues/4623)).

Root cause: `@expo/apple-utils` signs the ASC JWT with a 1200 s lifetime — Apple's exact
hard maximum. Any positive clock skew (≥ 1 s, routinely true in containers) makes the
token "1201 s" from Apple's side and Apple rejects it with 401.

The plan assumed there was an `eas-cli` version without the regression to pin. There is
not:

| eas-cli | `@expo/apple-utils` | JWT lifetime |
| --- | --- | --- |
| 24.13.0 (the issue's version) | 2.2.1 | 1200 s |
| 25.3.0 | 2.2.1 | 1200 s |
| 26.0.0 | 2.2.1 | 1200 s |
| 27.4.1 (current latest) | 2.3.0 | 1200 s |

Every published version, including today's latest, carries the 1200 s constant. So the
mitigation is ours to ship, not a version to pick:

1. **Preferred — do not let `@expo/apple-utils` sign at all.** With the cloud-side build
   path above, the runner resolves credentials locally from the workspace's ASC `.p8`
   and passes them in the job payload; nothing in the runner touches Apple's API.
2. **If we must run `eas-cli` (BYOK mode, where the user's own Expo account builds):**
   pin `eas-cli@27.4.1`, keep a `patches/@expo/apple-utils@2.3.0` entry that changes
   `o=1200` to `1140`, and retry once on `Apple 401` with a fresh token. The `patches/`
   directory is already used by this repo.
3. **Never** rely on `--non-interactive` alone: on 401, `eas-cli` falls back to the
   Apple ID login flow, which hangs instead of failing.

## Options

**A. Token-less runner + cloud-side EAS calls (recommended).** The runner computes the
build job and tars the project — no token, no Expo credentials in the runtime. Our cloud
mints an upload session, the runner `PUT`s the archive, the cloud calls
`createIosBuild` / `createWorkflowRun` / `create*Submission` with the org token, and the
webhook meters. This is what the GraphQL schema actually wants (it is how `eas-cli`
itself works), it removes the "user code runs in the same process as `EXPO_TOKEN`"
threat that forced one org per workspace, and it lets a **single** Shogo Expo account
hold many projects. Cost: we reimplement ~200 lines of `eas-cli`'s job assembly and must
track build-job schema changes. Its ceiling is the account's project cap (25 on Free, 100
on Production), so a single account runs out at the same order of magnitude as one org
per workspace would have — sharding across a handful of Shogo-owned accounts is the
escape hatch, and it stays inside our own account, so it needs no Expo agreement.

**B. Per-workspace org created out of band.** Keep the plan's tenancy, but
`ensureExpoOrg` becomes "post an internal provisioning request"; orgs are created by hand
or by a script against Expo's private dashboard API. Blocked on Expo saying yes, and it
does not scale to sign-ups.

**C. BYOK only for v1.** Users paste their own `EXPO_TOKEN`. White-label the UX and the
runner, meter nothing, Expo bills the user. Ships with no Expo agreement and no new
tenancy risk, but it is not the product Russell asked for on its own.

A and C are not exclusive: C is the fallback that must work on day one, and A turns it
into managed mode later without touching the schema or the routes — only where the token
comes from (and who calls the build mutation) changes.

## The webhook body

The delivered JSON has **no `event` field and no `buildDetails`**. Reading either
one is how an earlier revision routed every build into the submit branch —
nothing was metered, no build left `in_progress`, and no store submission was
started. The two bodies share `id`, `status`, `platform`, `appId` and the
timestamps, and are otherwise different shapes:

```json
// BUILD — https://docs.expo.dev/eas/webhooks/
{ "id": "<build id>", "status": "finished", "platform": "ios", "appId": "<eas app id>",
  "resourceClass": "ios-medium", "actualResourceClass": "IOS_LARGE",
  "artifacts": { "buildUrl": "https://expo.dev/artifacts/eas/<file>", "logsS3KeyPrefix": "..." },
  "metadata": { "buildProfile": "shogo-store", "distribution": "store", ... },
  "error": { "message": "...", "errorCode": "..." }, "createdAt": "...", "completedAt": "..." }

// SUBMIT — id is the SUBMISSION id
{ "id": "<submission id>", "status": "finished", "platform": "android", "appId": "<eas app id>",
  "submissionDetailsPageUrl": "...", "archiveUrl": "...", "turtleBuildId": "...",
  "submissionInfo": { "error": { "message": "...", "errorCode": "..." }, "logsUrl": "..." } }
```

So: **the query is the discriminator** (`?event=build` / `?event=submit`), and
`detectWebhookEvent` falls back to shape (`submissionInfo` / `archiveUrl` /
`turtleBuildId` ⇒ submit; `artifacts` / `metadata` / `resourceClass` ⇒ build) only
for a webhook an older revision created on the bare path. An unrecognisable body
is a logged ops event, not a guess.

Two more consequences worth writing down:

- **Bill by `actualResourceClass`.** `resourceClass` is what was asked for;
  `actualResourceClass` is what ran, and it is what the invoice names.
- **The "build before its row exists" suppression is per app, not per account.**
  A test-stage build is started by the workflow and only adopted by the poller a
  tick later, so it can arrive with no `NativeBuild`. Suppressing that alert
  account-wide meant one busy release hid a hand-started build on every other
  project, so the check is scoped to the payload's `appId`.

## What closes a charge the webhook dropped

The webhook is the fast path and is allowed to be lossy; Expo's retry window is
not ours. `sweepNativeMeters` runs inside the `native-release-poll` pass (same
`withGlobalJobLock`, no second cron) and re-walks three things: a claim held
through a crash (`meterStatus='metering'`, `meteredAt` set — reset after ten
minutes so the charge is retried rather than lost), a finished build nobody
billed, and unpriced rows, which are counted and alerted once and never billed at
a guess. `native-update-monthly` is scheduled the same way; both crons no-op
outside `cloud` mode.

## A profile that pins no resource class is not "the default price"

`eas.json`'s `resourceClass` is `default | medium | large`, it lives under
`android`/`ios`, and *omitting* it runs on `default`, whose concrete
`BuildResourceClass` differs by platform. The meter prices a build from the class
we chose, so an unpinned profile means the quote and the invoice can disagree —
on iOS plausibly by landing on the unpriced `IOS_M_MEDIUM`. The generated
`shogo-test` and `shogo-store` profiles therefore pin it, and the value comes from
the API (`NativeReleaseState.testResourceClass`, derived from
`TEST_BUILD_RESOURCE_CLASS`) because the API is the side that prices the build.
