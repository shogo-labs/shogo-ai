// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Cloud-init (user_data) generator for auto-provisioned BURST hosts.
 *
 * When the fleet reconciler scales a region up it creates a Latitude server and
 * hands it this script as user_data. On first boot the box must go from bare
 * Ubuntu to a fully-joined fleet member with NO human in the loop:
 *
 *   1. write /etc/metal-agent.env (shared secrets + this host's identity);
 *   2. write the OCIR pull creds so the rootfs build can pull the runtime image;
 *   3. fetch the fleet bundle (host-bootstrap.sh + build-runtime-rootfs.sh +
 *      the node-agent source + provision-burst-host.sh) from object storage;
 *   4. run provision-burst-host.sh, which preps the host, BUILDS runtime.ext4
 *      from the OCIR image (same image the whole fleet runs), deploys the agent,
 *      and `systemctl enable --now metal-agent`.
 *
 * The heavy artifact (~11 GB rootfs) is built on-box from the container image
 * rather than shipped, so the only thing delivered over the wire is a tiny
 * scripts+source bundle — always in lockstep with the image tag.
 *
 * The data path matches the existing hosts: the agent registers its PUBLIC IPv4
 * as METAL_MESH_IP/METAL_PUBLIC_HOST (auto-detected at boot) and the control
 * plane reaches it + its per-VM forwarded ports over the internet, locked to the
 * control-plane egress CIDR. No WireGuard enrolment is needed.
 *
 * SECURITY: user_data is account-private on Latitude (like the plaintext
 * /etc/metal-agent.env already on every host). It carries the register token,
 * S3 creds, and OCIR pull config — the same secrets a host already holds. Never
 * log the rendered script.
 */

/**
 * Default idle-suspend window baked into a host's env when the caller doesn't
 * override it. 30 minutes: long enough that a project a user is actively
 * iterating on (edit → look → edit, with think time) stays hot on its microVM
 * across the whole session, so opens are instant same-host resumes instead of
 * the constant suspend/resume churn a short (e.g. 45s) window caused. The GC's
 * LRU eviction still reclaims genuinely-idle projects under disk pressure, so a
 * longer window trades a little idle RAM for far fewer cold wakes.
 */
export const DEFAULT_IDLE_SUSPEND_MS = 30 * 60 * 1000

export interface BurstUserDataOpts {
  /** METAL_HOST_ID the agent registers with (matches the reconciler's record). */
  hostId: string
  /** Logical region (us|eu|...). */
  region: string
  /** Control-plane base URL the agent heartbeats to. */
  controlPlaneUrl: string
  /** Shared register/assign bearer token (SHOGO_INTERNAL_SECRET on the API). */
  registerToken: string
  /** Control-plane egress CIDR allowed to reach forwarded VM ports (e.g. 1.2.3.4/32). */
  fwdAllowCidr: string

  // Durable snapshot store (OCI S3-compat). For EU hosts point these at the EU
  // bucket/endpoint for data residency.
  s3Endpoint: string
  s3Region: string
  s3Bucket: string
  s3Prefix: string
  s3AccessKeyId: string
  s3SecretAccessKey: string

  /** Base64 docker config.json with the OCIR pull secret (from the cluster). */
  ocirDockerConfigB64: string
  /** Runtime image ref to bake into the rootfs (must be amd64-resolvable). */
  runtimeImage: string
  /** HTTPS URL (e.g. an OCI pre-authenticated request) to the fleet bundle tgz. */
  bundleUrl: string

  // Tunables — default to the validated staging profile.
  work?: string
  listenPort?: number
  poolSize?: number
  memMiB?: number
  vcpus?: number
  idleSuspendMs?: number
  heavyConcurrency?: number
  rootfsCow?: 'dm' | 'reflink' | 'full'
}

/** Shell-quote a value for safe embedding in a single-quoted env assignment. */
function envLine(key: string, value: string | number): string {
  // Values here are ids/urls/base64/tokens — no single quotes expected, but
  // escape defensively so a stray quote can't break out of the heredoc line.
  const v = String(value).replace(/'/g, `'\\''`)
  return `${key}='${v}'`
}

/**
 * Render the burst-host cloud-init script. PURE (no I/O) so it is fully
 * unit-testable; the reconciler feeds it env-sourced values.
 */
export function buildBurstUserData(o: BurstUserDataOpts): string {
  const work = o.work ?? '/opt/fc-spike'
  const listenPort = o.listenPort ?? 9900
  const poolSize = o.poolSize ?? 6
  const memMiB = o.memMiB ?? 4096
  const vcpus = o.vcpus ?? 2
  const idleSuspendMs = o.idleSuspendMs ?? DEFAULT_IDLE_SUSPEND_MS
  const heavy = o.heavyConcurrency ?? 8
  const cow = o.rootfsCow ?? 'dm'

  // The env file mirrors a working host (read off latitude-dal-1). Per-host
  // fields (HOST_ID, REGION, MESH_IP/PUBLIC_HOST) are set here / at boot.
  const envBody = [
    envLine('METAL_WORK', work),
    envLine('METAL_ROOTFS', `${work}/img/runtime.ext4`),
    envLine('METAL_GUEST_INIT', '/usr/local/bin/fc-init'),
    envLine('METAL_MEM_MIB', memMiB),
    envLine('METAL_VCPUS', vcpus),
    envLine('METAL_POOL_SIZE', poolSize),
    envLine('METAL_LISTEN_HOST', '0.0.0.0'),
    envLine('METAL_LISTEN_PORT', listenPort),
    envLine('METAL_IDLE_SUSPEND_MS', idleSuspendMs),
    envLine('METAL_SNAP_STORE', 's3'),
    envLine('METAL_SNAP_BUCKET', o.s3Bucket),
    envLine('METAL_SNAP_PREFIX', o.s3Prefix),
    envLine('METAL_SNAP_SLIM', '1'),
    envLine('S3_ENDPOINT', o.s3Endpoint),
    envLine('S3_REGION', o.s3Region),
    envLine('AWS_ACCESS_KEY_ID', o.s3AccessKeyId),
    envLine('AWS_SECRET_ACCESS_KEY', o.s3SecretAccessKey),
    envLine('METAL_ROOTFS_COW', cow),
    envLine('METAL_DM_COW_DIR', `${work}/cow`),
    envLine('METAL_DM_COW_SIZE', '2G'),
    envLine('METAL_BASE_CACHE_DIR', `${work}/base-cache`),
    envLine('METAL_GC_INTERVAL_MS', '15000'),
    envLine('METAL_DISK_HIGH_PCT', '85'),
    envLine('METAL_DISK_LOW_PCT', '70'),
    envLine('METAL_CACHE_MAX_BYTES', '0'),
    envLine('METAL_CONTROL_PLANE_URL', o.controlPlaneUrl),
    envLine('METAL_REGISTER_TOKEN', o.registerToken),
    envLine('METAL_REGION', o.region),
    envLine('METAL_HOST_ID', o.hostId),
    envLine('METAL_FWD_ALLOW_CIDR', o.fwdAllowCidr),
    envLine('NODE_TLS_REJECT_UNAUTHORIZED', '0'),
    envLine('METAL_HEAVY_CONCURRENCY', heavy),
    envLine('METAL_S3_GET_CONCURRENCY', '8'),
    envLine('METAL_S3_GET_PART_MB', '16'),
    envLine('METAL_REAP_INTERVAL_MS', '15000'),
    // Persist the rootfs-rebuild inputs into the agent env so self-update's
    // rebuildRootfs (which inherits the metal-agent process env) can run the
    // bundled build-runtime-rootfs.sh — a rebuildRootfs release is a silent
    // no-op without these. DOCKER_CONFIG points at the OCIR creds written below.
    envLine('RUNTIME_IMAGE', o.runtimeImage),
    envLine('DOCKER_CONFIG', '/root/.docker-ocir'),
  ].join('\n')

  // NOTE: heredocs are quoted ('EOF') so the shell does NOT expand $VARS inside
  // — the values are already rendered. The public IP is detected at boot and
  // appended, since Latitude assigns it after provisioning.
  return `#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/metal-provision.log) 2>&1
echo "[metal-provision] start $(date -u +%FT%TZ) host=${o.hostId} region=${o.region}"

install -d /opt/metal-provision "${work}/img"

# --- 1. Base env (shared + per-host identity) --------------------------------
cat > /etc/metal-agent.env <<'METAL_ENV_EOF'
${envBody}
METAL_ENV_EOF

# Detect this box's public IPv4 and register it as the dial-back address.
PUB_IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me || ip -4 route get 1.1.1.1 | awk '{print $7; exit}')"
echo "[metal-provision] public ip = $PUB_IP"
{
  echo "METAL_MESH_IP='$PUB_IP'"
  echo "METAL_PUBLIC_HOST='$PUB_IP'"
} >> /etc/metal-agent.env

# --- 2. OCIR pull creds (for the on-box rootfs build) ------------------------
install -d /root/.docker-ocir
base64 -d > /root/.docker-ocir/config.json <<'OCIR_EOF'
${o.ocirDockerConfigB64}
OCIR_EOF
echo '${envLine('RUNTIME_IMAGE', o.runtimeImage)}' > /opt/metal-provision/runtime-image.env

# --- 3. Fetch the fleet bundle (scripts + node-agent source) -----------------
echo "[metal-provision] fetching bundle..."
curl -fsSL --retry 5 --retry-delay 5 -o /opt/metal-provision/bundle.tgz '${o.bundleUrl}'
tar -xzf /opt/metal-provision/bundle.tgz -C /opt/metal-provision

# --- 4. Provision: host prep -> build rootfs -> deploy agent -> start ---------
echo "[metal-provision] running provision-burst-host.sh..."
WORK='${work}' \
DOCKER_CONFIG=/root/.docker-ocir \
BUNDLE_DIR=/opt/metal-provision \
bash /opt/metal-provision/scripts/metal-agent/provision-burst-host.sh

echo "[metal-provision] done $(date -u +%FT%TZ)"
`
}
