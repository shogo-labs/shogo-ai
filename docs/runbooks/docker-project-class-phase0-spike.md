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
> for the artifacts this produced. The metal-agent class, data drive, port
> preview, and rootfs `DOCKER_CLASS=1` mode have since landed in the repo.
> What is still open is fleet configuration (`METAL_DOCKER_ROOTFS`,
> `METAL_DOCKER_POOL_SIZE`) and flipping `runtime.docker_class_enabled` —
> not the Phase 0 hardware question.

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

## What landed after the spike

Phase 0 used a hand-spawned Firecracker process so it never touched the live
pool. The product path is now in the repo:

- metal-agent places `vmClass: 'docker'` and provisions a second virtio drive
  labelled `shogo-docker`, mounted at `/var/lib/docker` by `start-dockerd.sh`.
- `build-runtime-rootfs.sh` installs that starter when `DOCKER_CLASS=1`.
  `self-update.ts` rebuilds the docker rootfs when `METAL_DOCKER_ROOTFS` is set,
  from the `*-docker-multiarch-*` image published by `runtime-multiarch.yml`.
- Declared and project-added ports, the public preview proxy (including
  cookies and WebSocket upgrades), and the `expose_port` agent tool are in
  the API and the runtime.

Still operator work, not code: set `METAL_DOCKER_ROOTFS` and a non-zero
`METAL_DOCKER_POOL_SIZE` on the docker-class host, then turn on
`runtime.docker_class_enabled`. A docker-class guest's `/var/lib/docker` does
not survive a move to a different host.
