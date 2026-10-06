#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Shogo Technologies, Inc.
#
# Start dockerd for a docker-class Firecracker guest, and for the local
# privileged-container check of the same image. Idempotent.
#
# The guest kernel's nftables backend does not work (Phase 0 spike), so this
# switches iptables to the legacy backend before dockerd starts. The docker
# data drive, labelled shogo-docker, is mounted at /var/lib/docker when it is
# attached. The socket is opened up for the runtime user (uid 1001).
set -u

log() { echo "[start-dockerd] $*" >&2; }

if [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1; then
  exit 0
fi

mkdir -p /var/lib/docker /var/run /sys/fs/cgroup

if ! mountpoint -q /var/lib/docker 2>/dev/null; then
  DEV="$(blkid -L shogo-docker 2>/dev/null || true)"
  if [ -n "$DEV" ]; then
    mount -t ext4 -o noatime "$DEV" /var/lib/docker || log "WARNING: docker drive $DEV failed to mount"
  fi
fi

if ! mountpoint -q /sys/fs/cgroup 2>/dev/null; then
  mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || log "WARNING: cgroup2 mount failed"
fi

if [ -x /usr/sbin/iptables-legacy ]; then
  update-alternatives --set iptables /usr/sbin/iptables-legacy >/dev/null 2>&1 || true
  update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy >/dev/null 2>&1 || true
fi

if ! command -v dockerd >/dev/null 2>&1; then
  log "dockerd is not installed"
  exit 1
fi

# Containers and builds inherit this priority, so the Shogo runtime keeps
# answering the host's health checks while a large image builds.
PRIO=(nice -n 10)
if command -v ionice >/dev/null 2>&1; then
  PRIO+=(ionice -c2 -n7)
fi
"${PRIO[@]}" dockerd >/var/log/dockerd.log 2>&1 &

ready=0
for _ in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  log "dockerd did not become ready"
  tail -n 40 /var/log/dockerd.log >&2 || true
  exit 1
fi

if getent group docker >/dev/null 2>&1; then
  chgrp docker /var/run/docker.sock 2>/dev/null || true
  chmod 660 /var/run/docker.sock 2>/dev/null || true
else
  chmod 666 /var/run/docker.sock 2>/dev/null || true
fi
if id appuser >/dev/null 2>&1; then
  usermod -aG docker appuser 2>/dev/null || true
fi
# A chmod after usermod covers the case where the group change does not
# apply to the already-running runtime process.
chmod 666 /var/run/docker.sock 2>/dev/null || true
log "dockerd is up"
