#!/usr/bin/env bash
# =============================================================================
# metal-agent-memguard — restart the node-agent before its own memory takes the
# host down with it.
# =============================================================================
# Why a watchdog and not a systemd memory limit (SHO-593):
#
#   `memory.max` on metal-agent.service would cap the WRONG processes. The
#   firecracker guests are children of the agent, so they sit in the agent's own
#   cgroup: on staging that cgroup holds 148 processes and 335 GB of guest
#   memory. Any MemoryMax small enough to catch the agent's runaway (tens of
#   GiB) would start OOM-killing live projects' VMs instead. `OOMScoreAdjust=`
#   has the same problem in reverse — children inherit it at fork, so every
#   guest would become the preferred victim.
#
#   The number that actually ran away is the agent PROCESS's own RSS (63 GiB
#   before the kernel OOM-killed it on 2026-11-26), and VmRSS is per-process, so
#   it excludes the guests. When it crosses the cap, a restart is safe and is
#   already the routine path: KillMode=process kills only the agent, the guests
#   are reparented and the next agent re-adopts them (pool.adopt). That is what
#   every code deploy does, with live projects staying up.
#
# So: watch, log, restart, cool down. Never touch the guests.
#
# Usage:
#   metal-agent-memguard              # check once (what the timer runs)
#   metal-agent-memguard --decide RSS_KB CAP_MIB LAST_EPOCH NOW_EPOCH
#                                     # pure decision, printed as `ok <why>` or
#                                     # `restart <why>`; unit-tested
#
# Env (from /etc/metal-agent.env):
#   METAL_AGENT_RSS_GUARD_MIB        restart threshold, MiB; 0 disables (49152)
#   METAL_AGENT_RSS_GUARD_WARN_MIB   log-only threshold, MiB (32768)
#   METAL_AGENT_RSS_GUARD_COOLDOWN_S minimum seconds between restarts (1800)
#
# Two thresholds, not one: a busy host legitimately holds a lot of agent heap.
# dal-2 sat at 26-29 GiB RSS for 14 days with no OOM, so a cap near that number
# would restart a healthy host every cooldown. The measured runaways are 63 GiB
# (the OOM) and 94 GiB (one snapshot burst), so the cap sits above the healthy
# plateau and the warn line records the climb before anything is restarted.
# =============================================================================
set -euo pipefail

ENV_FILE=/etc/metal-agent.env
STATE_FILE=/run/metal-agent-memguard.last
UNIT=metal-agent.service

# --- pure decision, so a test can drive it without a host --------------------
decide() {
  local rss_kb="$1" cap_mib="$2" last_epoch="$3" now_epoch="$4" warn_mib="${5:-0}"
  local cooldown_s="${METAL_AGENT_RSS_GUARD_COOLDOWN_S:-1800}"
  local cap_kb=$(( cap_mib * 1024 ))
  local warn_kb=$(( warn_mib * 1024 ))

  if [ "$cap_mib" -le 0 ]; then
    echo "ok disabled"
    return
  fi
  if [ "$rss_kb" -le 0 ]; then
    echo "ok no-rss"
    return
  fi
  if [ "$rss_kb" -le "$cap_kb" ]; then
    if [ "$warn_kb" -gt 0 ] && [ "$rss_kb" -gt "$warn_kb" ]; then
      echo "warn over-warn=$(( rss_kb / 1024 ))MiB warn=$(( warn_kb / 1024 ))MiB cap=$(( cap_kb / 1024 ))MiB"
      return
    fi
    echo "ok below-cap $(( rss_kb / 1024 ))MiB/$(( cap_kb / 1024 ))MiB"
    return
  fi
  # Over the cap: still respect the cooldown, or a restart loop would hammer a
  # host that is only over because it is still adopting its VMs back.
  if [ "$(( now_epoch - last_epoch ))" -lt "$cooldown_s" ]; then
    echo "ok cooling-down $(( now_epoch - last_epoch ))s/${cooldown_s}s over=$(( rss_kb / 1024 ))MiB"
    return
  fi
  echo "restart over=$(( rss_kb / 1024 ))MiB cap=$(( cap_kb / 1024 ))MiB"
}

if [ "${1:-}" = "--decide" ]; then
  [ $# -ge 5 ] || { echo "usage: $0 --decide RSS_KB CAP_MIB LAST_EPOCH NOW_EPOCH [WARN_MIB]" >&2; exit 2; }
  decide "$2" "$3" "$4" "$5" "${6:-0}"
  exit 0
fi

# --- the timer path ----------------------------------------------------------
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
CAP_MIB="${METAL_AGENT_RSS_GUARD_MIB:-49152}"
WARN_MIB="${METAL_AGENT_RSS_GUARD_WARN_MIB:-32768}"
COOLDOWN_S="${METAL_AGENT_RSS_GUARD_COOLDOWN_S:-1800}"

if [ "$CAP_MIB" -le 0 ]; then
  exit 0
fi

pid="$(systemctl show "$UNIT" -p MainPID --value 2>/dev/null || echo 0)"
if [ -z "$pid" ] || [ "$pid" = "0" ] || [ ! -r "/proc/$pid/status" ]; then
  exit 0
fi
rss_kb="$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)"
last=0
[ -r "$STATE_FILE" ] && last="$(cat "$STATE_FILE" 2>/dev/null || echo 0)"
now="$(date +%s)"

verdict="$(decide "$rss_kb" "$CAP_MIB" "$last" "$now" "$WARN_MIB")"
case "$verdict" in
  warn\ *)
    logger -t metal-agent-memguard "WARN ${verdict#warn } (pid $pid)" || true
    ;;
  restart\ *)
    # Restart BEFORE the kernel OOM-kills us: a restart is graceful (drain, VMs
    # re-adopted), an OOM kill is not, and the host keeps its guests either way.
    echo "$now" > "$STATE_FILE"
    logger -t metal-agent-memguard "RESTARTING $UNIT: ${verdict#restart } (pid $pid) — guests survive via KillMode=process + pool.adopt" || true
    systemctl restart "$UNIT"
    logger -t metal-agent-memguard "restart issued; new MainPID $(systemctl show "$UNIT" -p MainPID --value)" || true
    ;;
  *over=*)
    # Over the cap but cooling down: say so every tick, so the journal shows the
    # climb rather than just the restart.
    logger -t metal-agent-memguard "over cap, waiting out cooldown: ${verdict#ok }" || true
    ;;
esac
