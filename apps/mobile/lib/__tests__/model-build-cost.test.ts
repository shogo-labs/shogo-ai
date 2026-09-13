// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test"
import { modelCostHint, modelPickerHidesCostLabels } from "../model-build-cost"

describe("modelCostHint", () => {
  test("describes the chosen tier without inventing a dollar price", () => {
    expect(modelCostHint("economy")).toBe("Uses fewer credits per step")
    expect(modelCostHint("premium")).toBe("Most capable — uses more credits")
  })

  test("compares against the current pick so savings are obvious", () => {
    expect(modelCostHint("economy", "premium")).toBe("Lower cost than your current pick")
    expect(modelCostHint("premium", "economy")).toBe("Higher cost than your current pick")
    expect(modelCostHint("economy", "economy")).toBe("Uses fewer credits per step")
  })
})

describe("modelPickerHidesCostLabels", () => {
  test("hides cheaper / higher-cost on the native phone sheet", () => {
    expect(modelPickerHidesCostLabels(false, "sheet")).toBe(true)
    expect(modelPickerHidesCostLabels(true, "sheet")).toBe(true)
  })

  test("keeps web menu cost labels unless a picker asks for names only", () => {
    expect(modelPickerHidesCostLabels(false, "menu")).toBe(false)
    expect(modelPickerHidesCostLabels(true, "menu")).toBe(true)
  })
})
