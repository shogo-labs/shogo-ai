/**
 * The localhost-only signing default, used when no secret is configured.
 *
 * Both token modules fall back to it, so it lives here rather than in either of
 * them: they are mocked with partial surfaces all over the test suite, and a
 * cross-import between the two breaks every one of those mocks the moment it
 * gains a name (SHO-265).
 */
export const DEV_ONLY_SIGNING_SECRET = 'shogo-dev-only-runtime-token-secret'

/** Is this process running inside a cluster pod (any namespace, any cloud)? */
export function inCluster(): boolean {
  return Boolean(process.env.KUBERNETES_SERVICE_HOST)
}

/**
 * Is this a deployed workload, rather than a test or a local process?
 *
 * `KUBERNETES_SERVICE_HOST` alone is not enough to tell: the export and
 * workspace-move suites set it deliberately to exercise Kubernetes mode, so
 * keying on it alone failed every one of them (SHO-265 round 4). A *deployment*
 * is the case where `NODE_ENV` says so — which is exactly the case the
 * `warm-pool-rescue` Job declared as `staging` while shipping no signing
 * secret.
 */
function isDeployedWorkload(): boolean {
  const env = process.env.NODE_ENV
  return env === 'production' || env === 'staging'
}

/**
 * Refuse to *mint* with the localhost-only default from inside a cluster.
 *
 * A minted token is handed to a pod as its `RUNTIME_AUTH_SECRET` and is the
 * only credential it has to reach the API, so a token signed with the dev
 * default is rejected as `bad_hmac` by every API replica — the pod then fails
 * every project-scoped call until someone re-assigns it, which is what a burst
 * of `runtime_token_invalid reason=bad_hmac` looks like in the logs.
 *
 * The fallback used to be chosen by `NODE_ENV` alone, so a cloud job that
 * declared `NODE_ENV=staging` and carried no signing secret signed real pod
 * credentials with it: `warm-pool-rescue --heal` did exactly that for every pod
 * it healed (SHO-265). Verification deliberately keeps degrading to `bad_hmac`
 * — a 500 from the verifier would hide the reason — but minting never does.
 */
export function assertMintableSigningSecret(secret: string): void {
  if (secret !== DEV_ONLY_SIGNING_SECRET || !inCluster() || !isDeployedWorkload()) return
  throw new Error(
    '[RuntimeToken] FATAL: refusing to mint a runtime token with the localhost-only signing secret inside a ' +
      'cluster. Set AI_PROXY_SECRET or BETTER_AUTH_SECRET on this workload — a token signed with the fallback ' +
      'is rejected by the API as bad_hmac.',
  )
}
