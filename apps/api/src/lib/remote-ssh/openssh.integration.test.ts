// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Opt-in Remote-SSH integration test.
 *
 * Run with:
 *   REMOTE_SSH_INTEGRATION=1 bun test apps/api/src/lib/remote-ssh/openssh.integration.test.ts
 *
 * The test uses Docker only for the throwaway OpenSSH server. The host-side
 * transport is exercised exclusively through SSHConnection, including ssh,
 * scp, and both forwarding directions. Without the opt-in flag, Docker is
 * never probed and the suite is skipped.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";

import { bootstrapRemoteRuntime, shellQuote } from "./bootstrap";
import { createSSHConnection, type SSHConnection } from "./connection";
import { RemoteRuntimeManager } from "./remote-runtime";

interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited.
      }
      finish({ stdout, stderr, exitCode: null });
    }, timeoutMs);

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish({
        stdout,
        stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`,
        exitCode: null,
      });
    });
    child.once("close", (exitCode) => finish({ stdout, stderr, exitCode }));
  });
}

async function dockerAvailable(): Promise<boolean> {
  const result = await runProcess(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    5_000,
  );
  return result.exitCode === 0;
}

async function docker(
  args: string[],
  timeoutMs = 120_000,
): Promise<ProcessResult> {
  const result = await runProcess("docker", args, timeoutMs);
  if (result.exitCode !== 0) {
    throw new Error(
      `docker ${args.join(" ")} failed (${String(result.exitCode)}): ` +
        `${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("Could not allocate a local test port");
  return port;
}

async function closeServer(
  server: ReturnType<typeof createServer> | undefined,
): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function makeRuntimeArchive(root: string): Promise<Uint8Array> {
  const runtimeDir = join(root, "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await Bun.write(
    join(runtimeDir, "agent-runtime"),
    `#!/usr/bin/env bun
const workspace = process.env.WORKSPACE_DIR || process.env.PROJECT_DIR || ''
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(process.env.PORT),
  fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/health') return Response.json({ ok: true, workspace })
    if (path === '/workspace') return new Response(workspace)
    return new Response('not found', { status: 404 })
  },
})
process.on('SIGTERM', () => {
  server.stop()
  process.exit(0)
})
`,
  );
  await chmod(join(runtimeDir, "agent-runtime"), 0o755);
  const archivePath = join(root, "shogo-agent-runtime-linux-x64.tar.gz");
  await tar.c(
    {
      cwd: runtimeDir,
      file: archivePath,
      gzip: true,
    },
    ["agent-runtime"],
  );
  return new Uint8Array(await readFile(archivePath));
}

async function waitForMappedPort(container: string): Promise<number> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await runProcess(
      "docker",
      ["port", container, "22/tcp"],
      5_000,
    );
    const match = /:(\d+)\s*$/.exec(result.stdout.trim());
    if (result.exitCode === 0 && match) return Number(match[1]);
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for Docker port mapping for ${container}`);
}

async function waitForSsh(connection: SSHConnection): Promise<void> {
  let lastError = "SSH server did not become ready";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const result = await connection.exec("printf ready");
      if (result.exitCode === 0) return;
      lastError = result.stderr || `exit code ${String(result.exitCode)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await connection.close();
    await delay(1_000);
  }
  throw new Error(`Timed out waiting for SSH server: ${lastError}`);
}

const RUN_INTEGRATION = process.env.REMOTE_SSH_INTEGRATION === "1";
const DOCKER_AVAILABLE = RUN_INTEGRATION && (await dockerAvailable());

describe.skipIf(!RUN_INTEGRATION || !DOCKER_AVAILABLE)(
  "Remote-SSH OpenSSH integration",
  () => {
    test("connects, bootstraps, launches, forwards, writes a file, and stops", async () => {
      const tempRoot = await mkdtemp(
        join(tmpdir(), "shogo-remote-ssh-integration-"),
      );
      const containerName = `shogo-remote-ssh-${process.pid}-${Date.now()}`;
      let container: string | undefined;
      let connection: SSHConnection | undefined;
      let manager: RemoteRuntimeManager | undefined;
      let apiServer: ReturnType<typeof createServer> | undefined;

      try {
        const privateKeyPath = join(tempRoot, "id_ed25519");
        const keygen = await runProcess("ssh-keygen", [
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-f",
          privateKeyPath,
        ]);
        if (keygen.exitCode !== 0) {
          throw new Error(`ssh-keygen failed: ${keygen.stderr}`);
        }
        const publicKey = await readFile(`${privateKeyPath}.pub`, "utf8");
        const authorizedKeyB64 = Buffer.from(publicKey).toString("base64");

        const startupScript = `set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends openssh-server ca-certificates curl
useradd --create-home --shell /bin/bash remote-test
install -d -m 700 -o remote-test -g remote-test /home/remote-test/.ssh
printf '%s' "$SSH_AUTHORIZED_KEY_B64" | base64 -d > /home/remote-test/.ssh/authorized_keys
chown remote-test:remote-test /home/remote-test/.ssh/authorized_keys
chmod 600 /home/remote-test/.ssh/authorized_keys
install -d -m 755 /run/sshd
cat > /etc/ssh/sshd_config.d/shogo-remote-test.conf <<'EOF'
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
UsePAM no
EOF
exec /usr/sbin/sshd -D -e
`;
        const started = await docker([
          "run",
          "--detach",
          "--rm",
          "--name",
          containerName,
          "--hostname",
          "shogo-remote-test",
          "--publish",
          "127.0.0.1::22",
          "--add-host",
          "host.docker.internal:host-gateway",
          "--env",
          `SSH_AUTHORIZED_KEY_B64=${authorizedKeyB64}`,
          "oven/bun:1.3.11",
          "sh",
          "-lc",
          startupScript,
        ]);
        container = started.stdout.trim();
        const sshPort = await waitForMappedPort(container);

        connection = createSSHConnection({
          host: "127.0.0.1",
          username: "remote-test",
          port: sshPort,
          identityFile: privateKeyPath,
          controlPath: join(tempRoot, "control.sock"),
          connectTimeoutMs: 1_000,
        });
        await waitForSsh(connection);

        const archive = await makeRuntimeArchive(tempRoot);
        const digest = createHash("sha256").update(archive).digest("hex");
        const sidecar = new TextEncoder().encode(
          `${digest}  shogo-agent-runtime-linux-x64.tar.gz\n`,
        );
        const bootstrapConnection = {
          exec: async (command: string) => {
            const result = await connection!.exec(command);
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              // bootstrap.ts treats an omitted exit code as success. Convert
              // SSHConnection's pre-exit null into an explicit failure.
              exitCode: result.exitCode === null ? 1 : result.exitCode,
            };
          },
          upload: (localPath: string, remotePath: string) =>
            connection!.upload(localPath, remotePath),
        };
        const bootstrap = await bootstrapRemoteRuntime(bootstrapConnection, {
          version: "0.0.0",
          // Force the tested fallback path; the release bytes are supplied by
          // the local fetch seam and transferred through SSHConnection.upload.
          baseUrl: "http://127.0.0.1:1/releases",
          fetch: (async (input: RequestInfo | URL) =>
            new Response(
              (String(input).endsWith(".sha256")
                ? sidecar
                : archive) as unknown as BodyInit,
              { status: 200 },
            )) as typeof fetch,
        });
        expect(bootstrap.source).toBe("local-upload");
        expect(bootstrap.binaryPath).toBe(
          "~/.shogo-server/0.0.0/agent-runtime",
        );

        const remoteProjectDir = "/home/remote-test/workspace";
        const projectContent = "remote ssh integration fixture";
        await connection.exec(
          `mkdir -p ${shellQuote(remoteProjectDir)} && ` +
            `printf '%s' ${shellQuote(projectContent)} > ` +
            `${shellQuote(`${remoteProjectDir}/README.md`)}`,
        );

        apiServer = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("reverse-forward-ok");
        });
        await new Promise<void>((resolve, reject) => {
          apiServer?.once("error", reject);
          apiServer?.listen(0, "127.0.0.1", () => resolve());
        });
        const apiAddress = apiServer.address();
        const localApiPort =
          typeof apiAddress === "object" && apiAddress ? apiAddress.port : 0;
        if (!localApiPort)
          throw new Error("Could not start reverse-forward test server");

        const localAgentPort = await freePort();
        const remoteAgentPort = 37_100;
        const remoteApiPort = 37_101;
        manager = new RemoteRuntimeManager({
          connection,
          workspaceKey: "integration-workspace",
          remoteProjectDir,
          runtimeBinaryPath: bootstrap.binaryPath,
          remoteAgentPort,
          remoteApiPort,
          localAgentPort,
          localApiPort,
          env: {
            API_URL: "https://api.example.test/base",
            WORKSPACE_DIR: "/wrong/local/path",
            RUNTIME_AUTH_SECRET: "integration-secret",
          },
          healthTimeoutMs: 15_000,
          healthPollMs: 100,
          fetch,
        });

        const startedStatus = await manager.start();
        expect(startedStatus.status).toBe("running");
        expect(startedStatus.pid).toBeGreaterThan(0);
        expect(startedStatus.agentPort).toBe(localAgentPort);
        expect(startedStatus.remoteAgentPort).toBe(remoteAgentPort);
        expect(startedStatus.remoteApiPort).toBe(remoteApiPort);
        expect((await manager.getHealth()).healthy).toBe(true);

        const reverse = await connection.exec(
          `curl --fail --silent http://127.0.0.1:${remoteApiPort}`,
        );
        expect(reverse.exitCode).toBe(0);
        expect(reverse.stdout).toBe("reverse-forward-ok");

        const written = "written through the remote project path";
        const remoteFile = `${remoteProjectDir}/integration.txt`;
        const writeResult = await connection.exec(
          `printf '%s' ${shellQuote(written)} > ${shellQuote(remoteFile)}`,
        );
        expect(writeResult.exitCode).toBe(0);
        const readResult = await connection.exec(
          `cat ${shellQuote(remoteFile)}`,
        );
        expect(readResult.stdout).toBe(written);

        await manager.stop();
        expect(manager.status().status).toBe("stopped");
        const pidfile = await connection.exec(
          'test ! -e "$HOME/.shogo-server/run/integration-workspace/agent-runtime.pid"',
        );
        expect(pidfile.exitCode).toBe(0);
      } finally {
        await manager?.stop().catch(() => {});
        await connection?.close().catch(() => {});
        await closeServer(apiServer);
        if (container) {
          await runProcess("docker", ["rm", "--force", container], 30_000);
        }
        await rm(tempRoot, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
