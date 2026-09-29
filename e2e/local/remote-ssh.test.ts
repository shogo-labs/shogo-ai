// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Opt-in local Remote-SSH UI/route coverage.
 *
 * Required contract when REMOTE_SSH_E2E=1:
 *   REMOTE_SSH_E2E_SSH_TARGET=user@host-or-alias
 *   REMOTE_SSH_E2E_PORT=22
 *   REMOTE_SSH_E2E_IDENTITY_FILE=/absolute/path/to/private-key
 *   REMOTE_SSH_E2E_PATH=~                  # or a child path such as ~/fixture
 *
 * The API process must be able to read the identity file. The target must be
 * a disposable Linux SSH host with a writable home (or child) directory.
 * The suite is skipped for normal local E2E runs unless REMOTE_SSH_E2E=1.
 */

import { expect, test, type Page } from "@playwright/test";
import { LOCAL_API_BASE, openTeamHome } from "./helpers";

const RUN_REMOTE_SSH_E2E = process.env.REMOTE_SSH_E2E === "1";
const SSH_TARGET = process.env.REMOTE_SSH_E2E_SSH_TARGET?.trim() ?? "";
const SSH_PORT = process.env.REMOTE_SSH_E2E_PORT?.trim() ?? "";
const IDENTITY_FILE = process.env.REMOTE_SSH_E2E_IDENTITY_FILE?.trim() ?? "";
const REMOTE_PATH = process.env.REMOTE_SSH_E2E_PATH?.trim() || "~";
const HOST_LABEL = process.env.REMOTE_SSH_E2E_LABEL?.trim() || "Remote SSH E2E";

const missingContract = [
  !SSH_TARGET && "REMOTE_SSH_E2E_SSH_TARGET",
  !SSH_PORT && "REMOTE_SSH_E2E_PORT",
  !IDENTITY_FILE && "REMOTE_SSH_E2E_IDENTITY_FILE",
].filter((name): name is string => !!name);

function projectIdFromUrl(page: Page): string {
  const match = /\/projects\/([^/?#]+)/.exec(new URL(page.url()).pathname);
  if (!match?.[1]) throw new Error(`Expected a project URL, got ${page.url()}`);
  return decodeURIComponent(match[1]);
}

async function chooseRemoteChildPath(page: Page, path: string): Promise<void> {
  if (path === "~") return;
  if (!path.startsWith("~/") || path.split("/").some((part) => part === "..")) {
    throw new Error(
      'REMOTE_SSH_E2E_PATH must be "~" or a child path such as "~/fixture"',
    );
  }

  for (const segment of path.slice(2).split("/").filter(Boolean)) {
    const entry = page.getByText(segment, { exact: true }).last();
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.click();
    await page.waitForTimeout(250);
  }
}

async function expectRemoteRouteResponse(
  page: Page,
  path: string,
  allowedStatuses: number[],
): Promise<{ status: number; body: any }> {
  const response = await page.request.get(`${LOCAL_API_BASE}${path}`);
  expect(allowedStatuses, `${path} returned an unexpected status`).toContain(
    response.status(),
  );
  return {
    status: response.status(),
    body: await response.json().catch(() => null),
  };
}

test.describe("Remote-SSH local flow", () => {
  test.skip(
    !RUN_REMOTE_SSH_E2E,
    "Set REMOTE_SSH_E2E=1 and the documented SSH fixture variables to run",
  );

  test.beforeAll(() => {
    if (missingContract.length > 0) {
      throw new Error(
        `REMOTE_SSH_E2E=1 requires: ${missingContract.join(", ")}. ` +
          "See e2e/local/remote-ssh.test.ts for the fixture contract.",
      );
    }
    if (
      !/^\d+$/.test(SSH_PORT) ||
      Number(SSH_PORT) < 1 ||
      Number(SSH_PORT) > 65_535
    ) {
      throw new Error(
        "REMOTE_SSH_E2E_PORT must be an integer between 1 and 65535",
      );
    }
  });

  test("opens the SSH source, creates a remote project, and reaches remote routes", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // The local Playwright browser is not Electron, so opt into the same
    // desktop capability gate used by ProjectSourceMenu. SSH itself still
    // runs in the local API process through its normal connection module.
    await page.addInitScript(() => {
      const current = (window as any).shogoDesktop ?? {};
      (window as any).shogoDesktop = { ...current, isDesktop: true };
    });

    await openTeamHome(page);
    const sourceTrigger = page.getByTestId("project-source-menu-trigger");
    await expect(sourceTrigger).toBeVisible();
    await sourceTrigger.click();

    const remoteSource = page.getByTestId("project-source-remote-ssh");
    await expect(remoteSource).toBeVisible();
    await remoteSource.click();
    await expect(
      page.getByText("Connect to Remote Host", { exact: true }),
    ).toBeVisible();

    await page.getByText("Add a host", { exact: true }).click();
    await page.getByPlaceholder("Production server").fill(HOST_LABEL);
    await page.getByPlaceholder("deploy@example.com").fill(SSH_TARGET);
    await page.getByPlaceholder("22").fill(SSH_PORT);
    await page.getByPlaceholder("~/.ssh/id_ed25519").fill(IDENTITY_FILE);
    await page.getByRole("button", { name: "Add and connect" }).click();

    await expect(
      page.getByText("Choose remote folder", { exact: true }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await chooseRemoteChildPath(page, REMOTE_PATH);
    const projectName = `Remote SSH E2E ${Date.now()}`;
    await page.getByPlaceholder("Remote project").fill(projectName);
    await page.getByRole("button", { name: "Use this folder" }).click();

    await expect(page).toHaveURL(/\/projects\/[^/?#]+/, { timeout: 60_000 });
    await expect(page.getByTestId("remote-host-indicator")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("remote-host-indicator")).toContainText(
      HOST_LABEL,
    );

    const projectId = projectIdFromUrl(page);

    // Local filesystem routes must refuse to inspect the API machine for a
    // remote project. The runtime-backed routes may be ready (200) or still
    // starting/unconfigured (503), but must not silently use local paths.
    const files = await expectRemoteRouteResponse(
      page,
      `/api/projects/${encodeURIComponent(projectId)}/files`,
      [409],
    );
    expect(files.body?.error?.code).toBe("remote_project_requires_runtime");

    const fileWrite = await page.request.put(
      `${LOCAL_API_BASE}/api/projects/${encodeURIComponent(projectId)}/files/remote-e2e.txt`,
      { data: { content: "must be written by the remote runtime" } },
    );
    expect(fileWrite.status()).toBe(409);
    expect((await fileWrite.json()).error?.code).toBe(
      "remote_project_requires_runtime",
    );

    const terminal = await expectRemoteRouteResponse(
      page,
      `/api/projects/${encodeURIComponent(projectId)}/terminal/commands`,
      [200, 503],
    );
    if (terminal.status === 503) {
      expect(terminal.body?.error?.code).toBeTruthy();
    }

    const previewWake = await expectRemoteRouteResponse(
      page,
      `/api/preview/${encodeURIComponent(projectId)}/wake`,
      [200, 503],
    );
    if (previewWake.status === 200) {
      expect(previewWake.body?.ok).toBe(true);
      expect(typeof previewWake.body?.url).toBe("string");
    } else {
      expect(previewWake.body?.error?.code).toBe("runtime_unavailable");
    }
  });
});
