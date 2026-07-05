// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// pool-agent: a minimal in-guest stand-in for agent-runtime's pool mode, used
// to validate the Firecracker microVM substrate end-to-end (boot -> assign ->
// snapshot -> restore) BEFORE the full agent-runtime image is baked.
//
// It speaks the same HTTP contract the K8s/desktop warm pool uses:
//   GET  /health          -> 200 (pool controller readiness probe)
//   POST /pool/assign      {projectId, env} -> claims the VM for a project
//   GET  /pool/status      -> current assignment + liveness proof
//   POST /pool/quiesce     -> pre-snapshot hook (flush + drop stale sockets)
//   POST /pool/rehydrate   -> post-restore hook (reconnect external services)
//
// The quiesce/rehydrate hooks mirror what the real agent-runtime needs around a
// freeze: on quiesce it would close AI-proxy/MCP/LSP/DB sockets (which won't
// survive the freeze) and flush the workspace; on rehydrate it would reconnect
// them, re-sync the clock and pull any S3 delta. The stub just records that the
// hooks fired, which the lifecycle e2e asserts survived the snapshot round-trip.
//
// Crucially it keeps state in memory:
//   - bootID  : random, set once at process start. If it's unchanged after a
//               restore, the guest resumed from RAM (never rebooted) -> proves
//               the snapshot captured live memory.
//   - counter : increments every 100ms. Its post-restore value proves the
//               process continued from exactly where it was frozen.
//   - quiesceCount / rehydrateCount : incremented by the hooks. A post-restore
//               quiesceCount >= 1 proves the pre-snapshot hook ran AND that its
//               effect was captured in the frozen RAM (survived the round-trip).
//
// Build (static, no libc): CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
//   go build -trimpath -ldflags "-s -w" -o pool-agent ./pool-agent.go
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

var (
	bootID    = randHex(8)
	startedAt = time.Now()
	counter   atomic.Int64

	mu             sync.Mutex
	assigned       string
	assignedAt     time.Time
	assignCount    int
	quiesceCount   int
	rehydrateCount int
	quiesced       bool
)

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func statusPayload() map[string]any {
	mu.Lock()
	defer mu.Unlock()
	return map[string]any{
		"status":         "ok",
		"bootID":         bootID,
		"pid":            os.Getpid(),
		"uptimeMs":       time.Since(startedAt).Milliseconds(),
		"counter":        counter.Load(),
		"projectId":      assigned,
		"assignCount":    assignCount,
		"assignedAt":     assignedAt.UnixMilli(),
		"quiesceCount":   quiesceCount,
		"rehydrateCount": rehydrateCount,
		"quiesced":       quiesced,
	}
}

func main() {
	// Serial marker so the host can time cold-boot-to-listening.
	fmt.Printf("POOL-AGENT-UP bootID=%s pid=%d\n", bootID, os.Getpid())

	go func() {
		t := time.NewTicker(100 * time.Millisecond)
		defer t.Stop()
		for range t.C {
			counter.Add(1)
		}
	}()

	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, statusPayload())
	})
	http.HandleFunc("/pool/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, statusPayload())
	})
	http.HandleFunc("/pool/assign", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
			return
		}
		var body struct {
			ProjectID string            `json:"projectId"`
			Env       map[string]string `json:"env"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.ProjectID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "projectId required"})
			return
		}
		mu.Lock()
		assigned = body.ProjectID
		assignedAt = time.Now()
		assignCount++
		envCount := len(body.Env)
		mu.Unlock()
		fmt.Printf("ASSIGNED project=%s envKeys=%d\n", body.ProjectID, envCount)
		writeJSON(w, http.StatusOK, map[string]any{"assigned": body.ProjectID, "bootID": bootID})
	})

	// Pre-snapshot: the real runtime would flush the workspace + close AI-proxy/
	// MCP/LSP/DB sockets here so the frozen image has no half-open connections.
	http.HandleFunc("/pool/quiesce", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
			return
		}
		mu.Lock()
		quiesceCount++
		quiesced = true
		n := quiesceCount
		mu.Unlock()
		fmt.Printf("QUIESCE count=%d bootID=%s\n", n, bootID)
		writeJSON(w, http.StatusOK, map[string]any{"quiesced": true, "quiesceCount": n, "bootID": bootID})
	})

	// Post-restore: the real runtime would reconnect those sockets, re-sync the
	// wall clock and pull any S3 delta. Here we just clear the quiesced flag.
	http.HandleFunc("/pool/rehydrate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
			return
		}
		mu.Lock()
		rehydrateCount++
		quiesced = false
		n := rehydrateCount
		mu.Unlock()
		fmt.Printf("REHYDRATE count=%d bootID=%s\n", n, bootID)
		writeJSON(w, http.StatusOK, map[string]any{"rehydrated": true, "rehydrateCount": n, "bootID": bootID})
	})

	addr := ":8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	fmt.Printf("POOL-AGENT listening on %s\n", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Fprintf(os.Stderr, "listen error: %v\n", err)
		os.Exit(1)
	}
}
