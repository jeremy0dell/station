import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakeExternalCommandRunner,
  externalCommandDiagnosticFromSafeError,
  externalCommandErrorFromUnknown,
  isExternalCommandError,
  nodeExternalCommandRunner,
  resolveExecutablePath,
  runExternalCommand,
  safeErrorFromUnknown,
} from "@station/runtime";
import { afterEach, describe, expect, it } from "vitest";

describe("runtime external command boundary", () => {
  it("supports fakeable command execution", async () => {
    const result = await runExternalCommand(
      { command: "fake", args: ["status"] },
      createFakeExternalCommandRunner(async (input) => ({
        command: input.command,
        args: input.args ?? [],
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    );

    expect(result).toEqual({
      command: "fake",
      args: ["status"],
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
  });

  it("removes requested inherited environment keys without dropping unrelated values", async () => {
    process.env.DROP_ME = "drop";
    try {
      const result = await runExternalCommand({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(JSON.stringify({drop:process.env.DROP_ME,keep:process.env.KEEP_ME}))",
        ],
        env: { KEEP_ME: "keep" },
        unsetEnv: ["DROP_ME"],
      });

      expect(JSON.parse(result.stdout)).toEqual({ keep: "keep" });
    } finally {
      delete process.env.DROP_ME;
    }
  });

  it("distinguishes a missing working directory from a missing executable", async () => {
    const missingCwd = join(tmpdir(), `station-missing-cwd-${Date.now()}`);
    await expect(
      runExternalCommand({ command: process.execPath, cwd: missingCwd }),
    ).rejects.toMatchObject({
      code: "EXTERNAL_COMMAND_CWD_NOT_FOUND",
      cwd: missingCwd,
      command: process.execPath,
    });
    await expect(
      runExternalCommand({ command: `station-missing-command-${Date.now()}`, cwd: tmpdir() }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts command output in typed failures", () => {
    const error = externalCommandErrorFromUnknown(
      {
        message: "failed",
        stderr: "OPENAI_API_KEY=sk-secret000000000000 Bearer abcdefghijklmnop",
        stdout: "nothing",
        code: 1,
      },
      { command: "fake", args: ["run"] },
    );

    expect(error).toMatchObject({
      tag: "ExternalCommandError",
      command: "fake run",
      exitCode: 1,
    });
    expect(JSON.stringify(error)).not.toContain("sk-secret");
    expect(JSON.stringify(error)).not.toContain("abcdefghijklmnop");
  });

  it("preserves process exit codes through runtime boundary normalization", async () => {
    await expect(
      runExternalCommand(
        { command: "fake", args: ["fail"] },
        createFakeExternalCommandRunner(async () => {
          throw Object.assign(new Error("failed"), {
            code: 2,
            signal: "SIGTERM",
            stdout: "stdout",
            stderr: "stderr",
          });
        }),
      ),
    ).rejects.toMatchObject({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      command: "fake fail",
      exitCode: 2,
      signal: "SIGTERM",
      stdoutSnippet: "stdout",
      stderrSnippet: "stderr",
    });
  });

  it("can treat selected non-zero exit codes as command results", async () => {
    const result = await runExternalCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write('pending'); process.exit(8)"],
      allowedExitCodes: [8],
    });

    expect(result).toEqual({
      command: process.execPath,
      args: ["-e", "process.stdout.write('pending'); process.exit(8)"],
      stdout: "pending",
      stderr: "",
      exitCode: 8,
    });
  });

  it("supports inherited stdio for visible long-running commands", async () => {
    await expect(
      runExternalCommand({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        stdio: "inherit",
      }),
    ).resolves.toMatchObject({
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps external command normalization idempotent", () => {
    const first = externalCommandErrorFromUnknown(
      {
        tag: "ExternalCommandError",
        code: "EXTERNAL_COMMAND_FAILED",
        message: "External command failed.",
        hint: "Check the configured binary.",
        provider: "runtime-test",
        traceId: "trace_1",
        commandId: "cmd_1",
        projectId: "proj_1",
        worktreeId: "wt_1",
        sessionId: "sess_1",
        diagnosticId: "diag_1",
        exitCode: 7,
        signal: "SIGKILL",
        stdout: "OPENAI_API_KEY=sk-secret000000000000",
        stderr: "Bearer abcdefghijklmnop",
      },
      { command: "fake", args: ["--token", "secret-value"] },
    );
    const second = externalCommandErrorFromUnknown(first, {
      command: "fake",
      args: ["--token", "secret-value"],
    });

    expect(second).toMatchObject({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_FAILED",
      message: "External command failed.",
      hint: "Check the configured binary.",
      provider: "runtime-test",
      traceId: "trace_1",
      commandId: "cmd_1",
      projectId: "proj_1",
      worktreeId: "wt_1",
      sessionId: "sess_1",
      diagnosticId: "diag_1",
      command: "fake --token [REDACTED]",
      exitCode: 7,
      signal: "SIGKILL",
      stdoutSnippet: "OPENAI_API_KEY=[REDACTED]",
      stderrSnippet: "Bearer [REDACTED]",
    });
    expect(JSON.stringify(second)).not.toContain("sk-secret");
    expect(JSON.stringify(second)).not.toContain("secret-value");
    expect(JSON.stringify(second)).not.toContain("abcdefghijklmnop");
  });

  it("preserves typed command fields and evidence through runtime normalization", () => {
    const commandError = externalCommandErrorFromUnknown(
      {
        code: 7,
        signal: "SIGTERM",
        stdout: "stdout",
        stderr: "stderr",
      },
      { command: "fake", args: ["run"], cwd: "/tmp/project" },
    );
    const normalized = safeErrorFromUnknown(commandError, {
      tag: "RuntimeError",
      code: "RUNTIME_FAILED",
      message: "Runtime failed.",
    });

    expect(isExternalCommandError(normalized)).toBe(true);
    expect(normalized).toMatchObject({
      command: "fake run",
      cwd: "/tmp/project",
      exitCode: 7,
      signal: "SIGTERM",
      stdoutSnippet: "stdout",
      stderrSnippet: "stderr",
    });
    expect(externalCommandDiagnosticFromSafeError(normalized)).toMatchObject({
      type: "external_command",
      command: "fake run",
      cwd: "/tmp/project",
      exitCode: 7,
      signal: "SIGTERM",
      stdoutSnippet: "stdout",
      stderrSnippet: "stderr",
    });
  });

  it("redacts secrets from rendered command strings", () => {
    const error = externalCommandErrorFromUnknown(new Error("failed"), {
      command: "fake",
      args: [
        "--api-key=value-secret",
        "--token",
        "followup-secret",
        "OPENAI_API_KEY=sk-secret000000000000",
        "sk-secret111111111111",
        "safe-arg",
      ],
    });

    expect(error.command).toContain("fake");
    expect(error.command).toContain("--api-key=[REDACTED]");
    expect(error.command).toContain("--token [REDACTED]");
    expect(error.command).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(error.command).toContain("[REDACTED_SECRET]");
    expect(error.command).toContain("safe-arg");
    expect(error.command).not.toContain("value-secret");
    expect(error.command).not.toContain("followup-secret");
    expect(error.command).not.toContain("sk-secret");
  });

  it("aborts fakeable command execution on timeout", async () => {
    let aborted = false;
    const runner = createFakeExternalCommandRunner(
      (input) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }));
          });
        }),
    );

    await expect(
      runExternalCommand({ command: "fake", args: ["hang"], timeoutMs: 5 }, runner),
    ).rejects.toMatchObject({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_TIMEOUT",
      command: "fake hang",
    });
    expect(aborted).toBe(true);
  });

  it("does not let the node runner own timeout semantics", async () => {
    await expect(
      nodeExternalCommandRunner({
        command: process.execPath,
        args: ["-e", "setTimeout(() => console.log('ok'), 20)"],
        timeoutMs: 1,
      }),
    ).resolves.toMatchObject({
      stdout: "ok\n",
      exitCode: 0,
    });
  });

  it("propagates caller cancellation into the command runner", async () => {
    const controller = new AbortController();
    let aborted = false;
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const pending = runExternalCommand(
      { command: "fake", args: ["cancel"], signal: controller.signal },
      createFakeExternalCommandRunner(
        (input) =>
          new Promise((_, reject) => {
            input.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }),
              );
            });
            resolveReady();
          }),
      ),
    );

    await ready;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_ABORTED",
      command: "fake cancel",
    });
    expect(aborted).toBe(true);
  });

  it("keeps caller cancellation distinct from runtime timeouts", async () => {
    const controller = new AbortController();
    let resolveReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const pending = runExternalCommand(
      {
        command: "fake",
        args: ["cancel-with-timeout"],
        signal: controller.signal,
        timeoutMs: 1000,
      },
      createFakeExternalCommandRunner(
        (input) =>
          new Promise((_, reject) => {
            input.signal?.addEventListener("abort", () => {
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }),
              );
            });
            resolveReady();
          }),
      ),
    );

    await ready;
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      tag: "ExternalCommandError",
      code: "EXTERNAL_COMMAND_ABORTED",
      command: "fake cancel-with-timeout",
    });
  });
});

describe("resolveExecutablePath", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("resolves an executable file on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resolve-exec-"));
    tempDirs.push(dir);
    const tool = join(dir, "mytool");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o755);

    expect(await resolveExecutablePath("mytool", { pathEnv: dir })).toBe(tool);
  });

  it("does not resolve a present-but-non-executable file", async () => {
    // The bug this guards: a file that exists but lacks the execute bit (partial
    // install, wrong perms) previously resolved as a usable tool via F_OK only.
    const dir = await mkdtemp(join(tmpdir(), "resolve-exec-"));
    tempDirs.push(dir);
    const tool = join(dir, "mytool");
    await writeFile(tool, "#!/bin/sh\n");
    await chmod(tool, 0o644);

    expect(await resolveExecutablePath("mytool", { pathEnv: dir })).toBeUndefined();
  });
});
