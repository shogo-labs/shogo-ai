// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// The thrown ShogoError carries the raw response body in `details`, so we can
// switch on the structured server code (e.g. the cloud-proxy codes returned by
// the local/desktop API) and fall back to the server message otherwise.
function publishErrorCode(err: any): string | undefined {
  return err?.details?.error?.code ?? err?.details?.code
}

/**
 * The words for a publish failure code the API stored on the project
 * (`publishError`), used when a publish fails after the request that started it
 * already returned — the panel polls the status instead of holding the POST
 * (SHO-542), and every step now has a code rather than a thrown error.
 */
export function publishStatusMessage(code: string | null | undefined): string {
  switch (code) {
    case 'build_failed':
    case 'build_timeout':
      return "Your app's build failed, so nothing was deployed. Your published site (if any) is unchanged."
    case 'no_files':
      return 'The build produced no files to publish — check that the app builds and outputs to dist/.'
    case 'download_failed':
    case 'download_timeout':
      return 'The build finished but its output could not be read back. Please try again.'
    case 'upload_failed':
    case 'upload_timeout':
      return "Publishing failed while uploading your site. Please try again — if it keeps happening, we're on it."
    case 'configure_failed':
    case 'configure_timeout':
    case 'revision_not_ready':
      return "Publishing failed on our hosting side while setting up your site. This is us, not your app — please try again."
    case 'database_unavailable':
    case 'schema_push_failed':
    case 'seed_failed':
      return "Your app's database could not be prepared, so publishing stopped before deploying. Please try again."
    case 'destructive_schema_change':
      return 'Publishing was refused because it would delete data in your published database. Ask the agent to review the schema change.'
    case 'publish_in_progress':
      return 'A publish is already running for this app — it will finish on its own.'
    case 'publish_interrupted':
      return 'The publish stopped before it finished (the server restarted). Nothing new is live — publish again.'
    case 'publish_failed':
      return 'Publishing failed. Your published site (if any) is unchanged — please try again.'
    default:
      return 'Publishing failed. Please try again.'
  }
}

/** The workspace plan can't publish to a new or changed subdomain (Pro+ only). */
export function isPublishPlanError(err: any): boolean {
  return publishErrorCode(err) === 'plan_not_allowed'
}

export function publishErrorMessage(err: any): string {
  if (err?.name === 'AbortError') {
    return "This is taking longer than expected. We're likely experiencing elevated load — please try again in a moment."
  }
  switch (publishErrorCode(err)) {
    case 'cloud_signin_required':
      return 'Sign in to Shogo Cloud to publish from the desktop app.'
    case 'project_not_synced':
      return 'Sync this project to Shogo Cloud before publishing.'
    case 'cloud_unreachable':
      return "Couldn't reach Shogo Cloud. Check your connection and try again."
    case 'upload_timeout':
    case 'configure_timeout':
      return "Publishing timed out while setting up your site. Please try again — if it keeps happening, we're on it."
    default:
      return err?.message || 'Failed to publish'
  }
}
