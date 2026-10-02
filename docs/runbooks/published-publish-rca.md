# Published Publish Lifecycle RCA and Validation Runbook

Date: 2026-09-29

## Incident summary

The Publish button exhibited two different failure modes before and after PR
#1079. Before the PR, publication could report success while the published
page was blank. After the PR, the frontend artifact and backend classification
were corrected, which caused server-backed projects to enter the published
Metal runtime path; that path then timed out during guest assignment.

This was therefore not a previously healthy published application being broken
by #1079. It was an existing broken publication being changed from a silent
static/asset failure into an observable backend-startup failure.

## Evidence-backed causal chain

### Before #1079: successful upload, unusable page

1. Preview builds were rooted at `/p/<projectId>/`. Their HTML referenced
   project-prefixed asset URLs such as `/p/<projectId>/assets/...`.
2. Published sites were served at `/`, while the publisher uploaded those
   assets under the published root.
3. The asset requests missed their objects. The edge fallback returned HTML for
   JavaScript and CSS requests, so the browser rejected them under strict MIME
   checking. The result was a blank page even though the publish operation had
   completed.
4. Backend detection inspected the merged workspace root instead of the
   selected project subtree. A project containing a backend was consequently
   classified as static-only and no published backend VM was started.

The browser console evidence is the `text/html` response for a module and
stylesheet request. The historical successful publish trace was
`38361c7ae033b08bea8efb37304936d3`; the September 28 publishes were recorded
as `serverBacked: false`.

### After #1079: correct artifact, exposed runtime timeout

PR #1079 introduced the root-hosted build artifact and passed `projectId` into
artifact, backend-detection, schema, and writable-data inspection. The same
project was then correctly classified as server-backed:

```text
serverBacked: true
hasModels: true
hasCustomRoutes: true
hasServerFile: true
```

The build and upload completed, but published VM assignment timed out after
30 seconds. Sanitized trace references are:

| Environment | Trace | Observed sequence |
| --- | --- | --- |
| Production, first post-PR attempt | `0a0540e6fbf693e3a162fb587613933f` | root build → upload → backend detected → assignment timeout |
| Production, latest retry | `c627fb56f8472513752f1d90e718c224` | same sequence and timeout |
| Staging reproduction | `7f6b9d46f82c5a05d1db5d55df3b9055` | same timeout after published assignment |

The PR merge was `02103ae...`; the production published release observed in
the investigation was `9d6f...`.

### Root cause of the timeout

Warm-pool guests boot from a generic image. The published mode is injected by
`/pool/assign`, but the runtime previously captured `IS_PUBLISHED_MODE` at
module import time. The assigned guest therefore followed normal initialization
instead of the published path.

Normal initialization can enter guest-owned object-storage setup. Published
Metal guests intentionally have no object-storage credentials because the host
owns source and writable-data hydration. The credential provider can wait for
the instance metadata chain. The guest-side wait is longer than the host's
30-second assignment deadline, so the host tears down the VM and Publish
returns a timeout.

Supporting diagnostic observations were:

- the published guest had no AWS access/secret keys;
- the installed runtime contained the awaited credential initialization path;
- credential lookup remained unresolved for 35,001 ms;
- disabling metadata lookup made the diagnostic subprocess fail in 348 ms.

The assignment timeout and classification change are confirmed. The exact last
startup operation of the production guest was not captured, so the credential
stall is documented as the reproduced and strongly supported mechanism, not as
an invented production stack trace.

## Repair implemented in this branch

The branch `fix/published-runtime-lifecycle` contains two commits:

- `fix: defer published runtime startup until host hydration`
  - published warm-pool assignment is inert until the host has applied source
    and writable-data archives;
  - published guests skip guest-owned S3 hydration, Git bootstrap, source
    watchers, and agent-gateway startup during assignment;
  - authenticated `/pool/startup-status` and `/pool/published-ready` endpoints
    expose bounded phase diagnostics and idempotent activation;
  - readiness stays false until the published static/API serving gates are
    healthy;
  - host hydration uses the real project ID rather than the routing identity
    `published:<projectId>`;
  - existing published-data restore failures fail closed instead of silently
    starting with a fresh database;
  - failed assignment/activation captures runtime status and filtered serial
    diagnostics before VM teardown.

- `fix: pin published services to immutable source releases`
  - each publish prepares a unique immutable `publish/<subdomain>/<timestamp>-<nonce>`
    tag before provisioning;
  - the explicit tag is passed through Knative/Metal provisioning and wake;
  - the stable `published/<subdomain>` pointer advances only after provisioning
    succeeds, and future wakes use the persisted immutable tag;
  - changing subdomains no longer deletes the old static prefix before the new
    service is configured;
  - published runtime and durable source identities remain distinct.

## Compatibility notes

- Existing unversioned `published/<subdomain>` tags remain readable for legacy
  deployments. If an explicit release tag is unavailable, runtime checkout
  retains the legacy fallback behavior.
- Static applications still publish without a VM.
- Knative/non-host-managed storage behavior is unchanged; the host-mediated
  exemption applies to published Metal guests as well as workspace Metal
  guests.
- The existing `publishedTag` project field is reused as the persisted source
  release reference; no destructive data migration is required.
- No production or staging deployment is part of this branch.

## Operator staging validation

Run only after deploying the branch to staging, with an operator-owned test
project. Do not use production data.

1. Publish a static project and verify the root HTML, JavaScript, and CSS all
   return 200 with the correct MIME types.
2. Publish a server-backed project and verify the assignment completes without
   an AWS credential lookup or 30-second timeout.
3. Query the guest's authenticated `/pool/startup-status` during startup and
   after activation. Confirm the phase sequence is
   `awaiting-hydration → starting → ready`.
4. Exercise a backend endpoint and verify the response comes from the selected
   release, not the builder's later `HEAD`.
5. Republish after changing both frontend and backend code. Confirm the new
   release marker is served and the prior writable database/uploads remain.
6. Suspend and wake the published app. Confirm the persisted `publishedTag` is
   used and the app becomes ready again.
7. Change the subdomain and verify the old site remains available until the
   new site is configured, then verify old static objects are retired.
8. Test both public and password-protected publishing without changing the
   selected access policy.

## Failure and rollback checklist

- If preparation fails, leave the active release, routing, and writable-data
  archive unchanged.
- If backend assignment or readiness fails, do not advance the stable pointer
  or mark the candidate live. Preserve the previous runtime/snapshot for
  rollback and inspect the bounded startup-status/serial diagnostics.
- If an existing published-data archive cannot be read or applied, stop the
  replacement VM. Never treat that failure as a first publish.
- If promotion fails after a successful backend replacement, restore the prior
  routing/pointer and keep the candidate isolated for inspection.
- If rollback itself fails, report the original failure and rollback failure as
  separate errors; do not silently claim the publish succeeded.

## Validation performed in this PR

The focused changed-code suite passed with 77 tests, including runtime
assignment, readiness, source-key isolation, published-data behavior,
controller routing, release-tag forwarding, wake propagation, and substrate
contracts.

The repository's broader typecheck is not clean on the base branch: it reports
pre-existing generated-Prisma/rootDir and unrelated runtime typing errors. The
existing Git integration tests also require repository user configuration in
the execution environment. Those limitations are separate from the focused
tests above and were not hidden as passing validation.
