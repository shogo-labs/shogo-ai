// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { parseGenerateVideoResult, videoCardState } from "../generate-video-result"

describe("generate video result", () => {
  test("parses JSON string results", () => {
    expect(parseGenerateVideoResult('{"status":"completed","path":"videos/a.mp4"}')).toEqual({
      status: "completed",
      path: "videos/a.mp4",
    })
    expect(parseGenerateVideoResult("not json")).toBeNull()
    expect(parseGenerateVideoResult(undefined)).toBeNull()
  })

  test("a saved clip is ready", () => {
    expect(videoCardState({ status: "completed", path: "videos/a.mp4" }, "success")).toBe("ready")
  })

  test("a planned path alone is still queued", () => {
    expect(videoCardState({ status: "queued", job_id: "vid_1", planned_path: "videos/a.mp4" }, "success")).toBe("queued")
    expect(videoCardState({ status: "in_progress", job_id: "vid_1", path: "videos/a.mp4" }, "success")).toBe("queued")
  })

  test("errors and failed jobs show as failed", () => {
    expect(videoCardState({ error: "Insufficient balance" }, "success")).toBe("failed")
    expect(videoCardState({ status: "failed", job_id: "vid_1" }, "success")).toBe("failed")
  })

  test("a running call renders a placeholder", () => {
    expect(videoCardState(null, "streaming")).toBe("rendering")
    expect(videoCardState(null, undefined)).toBe("rendering")
  })
})
