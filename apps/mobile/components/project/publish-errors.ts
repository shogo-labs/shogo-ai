// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

// The thrown ShogoError carries the raw response body in `details`, so we can
// switch on the structured server code (e.g. the cloud-proxy codes returned by
// the local/desktop API) and fall back to the server message otherwise.
function publishErrorCode(err: any): string | undefined {
  return err?.details?.error?.code ?? err?.details?.code
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
