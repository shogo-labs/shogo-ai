<!--
SPDX-License-Identifier: AGPL-3.0-or-later
Copyright (C) 2026 Shogo Technologies, Inc.
-->

# Docker project class — Phase 0 spike results

> **Status**: Phase 0 (feasibility) of the Tier 2 Docker-capable project class
> plan is **done**. This validated the single biggest open risk — whether
> dockerd can run inside a Firecracker guest at all on our fleet's existing
> guest kernel — directly on real staging hardware. Result: **yes, with no
> kernel changes**, plus suspend/resume with live containers. See
> [`packages/agent-runtime/tech-stacks/docker-compose/stack.json`](../../packages/agent-runtime/tech-stacks/docker-compose/stack.json)
> and [`packages/agent-runtime/Dockerfile.docker`](../../packages/agent-runtime/Dockerfile.docker)
> for the artifacts this produced. Phase 1 (metal-agent per-class pool/placement)
> is still not started — see that section below.

## What was tested, and where

Everything below ran directly on the live staging metal host `latitude-dal-1`
(`72.46.85.83`), against the **exact guest kernel already deployed to the
fleet** (`vmlinux-6.1.102`, fetched by `host-bootstrap.sh` from the Firecracker
CI kernel bucket — see `scripts/metal-agent/host-bootstrap.sh`). Nothing here
touched the live warm pool: every VM was spawned as a standalone `firecracker`
process on an isolated `spiketap0` device (not the `fctap<n>` naming pattern
the pool's orphan-tap GC matches on), using throwaway copies of the golden
`runtime.ext4` / a separate image tag never pushed to the registry. The host
returned to its pre-spike state (same live VM count, same taps, same disk
usage, no leftover processes/images/mounts) once each test completed.

## Result 1 — the stock guest kernel supports everything dockerd needs

Booted the fleet's real `vmlinux-6.1.102` with a Debian rootfs, `docker.io` +
`docker-cli` + `docker-buildx` installed, plus the `docker/compose` v2 static
binary (no `docker-compose-plugin` package exists yet for this base's distro
release). Confirmed present and working with **zero kernel changes**:

- overlay filesystem (`overlay2` storage driver)
- cgroup v2, with `cpuset cpu io memory hugetlb pids` controllers
- bridge + veth (docker's default bridge network, custom `docker compose`
  networks, published ports)
- IP forwarding / NAT

This means **Phase 0's `scripts/metal-agent/build-guest-kernel.sh` step from
the original plan is not needed.** The kernel already on every host works.

### The one catch: dockerd's default iptables backend

First boot attempt: `dockerd` failed outright —

```
failed to register "bridge" driver: failed to create NAT chain DOCKER:
iptables failed: iptables -t nat -N DOCKER: iptables: Failed to initialize nft:
Protocol not supported
```

Debian defaults `iptables` to the `iptables-nft` backend (nftables-based).
This specific compiled kernel binary doesn't support whatever `nft`
initialization needs, despite `CONFIG_NF_TABLES=y` in the public reference
config for this kernel line (not root-caused further — possibly a narrower gap
in the specific compiled artifact vs. the config source). The fix has no
kernel dependency at all:

```bash
update-alternatives --set iptables /usr/sbin/iptables-legacy
update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy
```

This switches Docker to the legacy `ip_tables.ko`-style netfilter API, which
the kernel fully supports (`CONFIG_IP_NF_IPTABLES`, `CONFIG_IP_NF_NAT`,
`CONFIG_IP_NF_MANGLE`, `CONFIG_NF_NAT_MASQUERADE`, etc. are all built in). No
functional loss for a single-tenant guest that has no other reason to want
nftables specifically.

Second (minor) fix: `--userland-proxy=false` on the `dockerd` invocation —
Debian's `docker-proxy` binary lands at `/usr/sbin/docker-proxy` but dockerd's
default path detection didn't find it in this minimal install. Disabling the
userland proxy is also the generally-recommended posture for a daemon with
working iptables DNAT (one less process per published port, no functional
loss). Baked into `/etc/docker/daemon.json` in `Dockerfile.docker` rather than
passed as a flag.

Both fixes are captured in
[`packages/agent-runtime/Dockerfile.docker`](../../packages/agent-runtime/Dockerfile.docker).

## Result 2 — a full compose stack works end-to-end

With those two fixes, booted the **actual PR starter**
(`packages/agent-runtime/tech-stacks/docker-compose/starter/`: FastAPI app +
Postgres, `docker compose up -d --build`) inside the guest:

- multi-container bridge network, veth pairs, `depends_on: condition:
  service_healthy` — all worked
- Postgres reported `healthy` via its `pg_isready` healthcheck
- the app built (`python:3.12-slim` + pip install), started, and served
  `GET /health` → `{"status": "ok", "db": "ok"}` — a real DB round trip through
  the compose network

This surfaced a real bug in the starter, now fixed: the `DATABASE_URL`
default used the `postgres://` scheme, which SQLAlchemy 2.x's driver registry
doesn't recognize (`NoSuchModuleError: Can't load plugin:
sqlalchemy.dialects:postgres`). Changed to `postgresql+psycopg2://` in both
`docker-compose.yml` and `main.py`'s fallback default.

## Result 3 — suspend/resume with LIVE containers survives a real snapshot cycle

This was the other open question from the plan: does a running Docker Engine
+ containers survive our actual suspend mechanism, not just a `Ctrl+Z`-style
pause? Ran the **exact sequence `firecracker-vm-manager.ts` uses**
(`net.ts`'s `setupTap` + `FcApi.pause/createSnapshot/loadSnapshot`), not a
simplified stand-in:

1. `PATCH /vm {state: Paused}` on the running VM (app + db containers live).
2. `PUT /snapshot/create` → full snapshot (vmstate + 4 GiB memory file) to disk.
3. `kill -9` the firecracker process (simulates a node-agent restart / the VM
   being fully evicted from memory — not just paused).
4. Delete + recreate the tap device (`net.ts`: "the tap must exist again
   before LoadSnapshot").
5. Spawn a **brand-new** `firecracker` process with a fresh API socket.
6. `PUT /snapshot/load` with `resume_vm: true` as the **first** API call on
   that process (Firecracker rejects `snapshot/load` if any boot-specific
   resource, e.g. `/network-interfaces`, was configured first on that
   process — the host-side tap must simply already exist, no FC-API call
   for it before restore).

Immediately after restore, `curl http://<guest-ip>:8000/health` on the new
process returned `{"status": "ok", "db": "ok"}` — the FastAPI process, its
Postgres connection, and the docker bridge networking all resumed correctly
with no reconnect logic needed, verified stable across multiple follow-up
checks.

## Result 4 — the real image + real build pipeline + real agent-runtime all coexist

The above used a hand-built rootfs to isolate variables. As a closing,
higher-fidelity check, went through the **actual production artifacts**:

1. Wrote [`packages/agent-runtime/Dockerfile.docker`](../../packages/agent-runtime/Dockerfile.docker) —
   a thin layer on the real `shogo-runtime` OCIR image adding the two fixes
   above. Built it for real: `DOCKER_CONFIG=/root/.docker-ocir docker build
   --build-arg BASE_IMAGE=...shogo-runtime:staging-multiarch-latest -f
   Dockerfile.docker .` — succeeded against the live staging image.
2. Fed the result through the **real** `scripts/metal-agent/build-runtime-rootfs.sh`
   (`PULL=false`) — the same script that builds every VM class's rootfs today.
   Produced a normal bootable ext4, no changes needed to the script itself.
3. Patched the generated `fc-init` to start `dockerd` (mount cgroup2, launch,
   wait for the socket) immediately before its existing `exec
   /entrypoint.sh` — i.e. dockerd starts, *then* the real agent-runtime bun
   server boots exactly as it does today.
4. Booted it on the real kernel. Both came up cleanly with no port/resource
   conflicts: `[fc-init] dockerd ready`, then the full existing warm-pool
   pre-warm pipeline (`Started server: http://localhost:8080`, tech-stack
   seed, `bun install`, `prisma generate`, codegen) completed exactly as it
   does for every non-Docker VM today.

This is strong evidence that adding dockerd to the guest is additive and
doesn't disturb the existing agent-runtime boot path at all.

## What Phase 0 does NOT cover (still Phase 1)

Phase 0 was scoped to "can this work at all, on this kernel" — it deliberately
used a hand-spawned, standalone `firecracker` process to stay isolated from
the live pool. None of the following were touched, and are still open:

- **metal-agent internals**: `apps/metal-agent/{pool,firecracker-vm-manager,
  fc-api,server}.ts` have no concept of VM classes yet. Wiring `vmClass:
  'docker'` through placement/capacity/warm-pool-per-class is real,
  unstarted engineering — not a hardware-access problem, a correctness one
  (see the reasoning already in PR #903's description for why that wasn't
  rushed even once bare-metal access was available for this spike).
- **A second virtio-blk data drive** for docker's `/var/lib/docker` — this
  spike put everything on the single root drive, which is fine for a spike
  but not for the eventual per-project storage isolation/GC story.
- **`build-runtime-rootfs.sh` doesn't have a `--docker-class` mode yet** — the
  fc-init dockerd-startup patch here was applied by hand, post-build, for the
  spike. Turning it into a real flag on the script (or a documented second
  script) is a small, low-risk follow-up now that the recipe is proven.
- Registry publishing of the actual `shogo-runtime:*-docker` image tag, and
  wiring it into the fleet's rootfs-selection logic by `vmClass`.
- Everything in Phase 3 (exposed ports / tunnel / public preview) and Phase 4
  (rollout) — unchanged from PR #903's scoping.
