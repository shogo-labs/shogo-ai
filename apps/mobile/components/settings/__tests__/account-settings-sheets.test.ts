// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from "bun:test";
import {
  accountSettingsSheetGroups,
  accountSettingsSheetTitle,
} from "../account-settings-sheets";

describe("accountSettingsSheetGroups", () => {
  test("labels come from the shared title map", () => {
    const groups = accountSettingsSheetGroups({
      localMode: false,
      showBilling: true,
    });
    const tabs = groups.flatMap((group) => group.tabs);
    expect(groups.map((group) => group.title)).toEqual(["Settings", "Plan"]);
    expect(tabs.find((tab) => tab.id === "billing")?.label).toBe(
      accountSettingsSheetTitle("billing")
    );
    expect(tabs.map((tab) => tab.id)).not.toContain("analytics");
    expect(tabs.map((tab) => tab.id)).not.toContain("costs");
  });

  test("hides cloud-only tabs in local mode", () => {
    const groups = accountSettingsSheetGroups({
      localMode: true,
      showBilling: false,
    });
    const ids = groups.flatMap((group) => group.tabs.map((tab) => tab.id));
    expect(ids).toContain("security");
    expect(ids).not.toContain("people");
    expect(ids).toContain("billing");
  });

  test("keeps Compute on Android phones and drops it on iOS", () => {
    const idsFor = (platform: string) =>
      accountSettingsSheetGroups({
        localMode: false,
        showBilling: true,
        platform,
      })
        .flatMap((group) => group.tabs)
        .map((tab) => tab.id);
    expect(idsFor("android")).toContain("compute");
    expect(idsFor("web")).toContain("compute");
    expect(idsFor("ios")).not.toContain("compute");
  });

  test("never offers the desktop-only tabs", () => {
    const ids = accountSettingsSheetGroups({
      localMode: true,
      showBilling: true,
      platform: "android",
    })
      .flatMap((group) => group.tabs)
      .map((tab) => tab.id);
    expect(ids).not.toContain("updates");
    expect(ids).not.toContain("computer-files");
  });
});
