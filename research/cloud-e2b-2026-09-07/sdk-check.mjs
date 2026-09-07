import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Import installed SDKs only after replacing fetch. Every provider operation below uses a fake.
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts += 1;
  throw new Error("Network is forbidden in this offline experiment");
};
const sdkRoot = resolve(process.argv[2]);
const tick = () => new Promise((done) => setImmediate(done));
const bytes = (value) => new TextEncoder().encode(value);
const event = (kind, value) => ({ event: { event: { case: kind, value } } });

function stream() {
  const pending = [];
  let wake;
  let ended = false;
  return {
    push(value) {
      pending.push(value);
      wake?.();
    },
    close() {
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (pending.length > 0) yield pending.shift();
        else if (ended) return;
        else
          await new Promise((done) => {
            wake = done;
          });
      }
    },
  };
}

function fixture(Sandbox) {
  const sandbox = new Sandbox({
    sandboxId: "offline-fixture",
    envdVersion: "0.5.0",
    apiKey: "synthetic-not-a-credential",
    domain: "example.invalid",
    apiUrl: "https://example.invalid",
    sandboxUrl: "https://example.invalid",
    debug: false,
  });
  const calls = [];
  const streams = [];
  const signals = [];
  const open = (method, request, options) => {
    calls.push({ method, request, timeoutMs: options.timeoutMs });
    signals.push(options.signal);
    const output = stream();
    output.push(event("start", { pid: 481 }));
    streams.push(output);
    return output[Symbol.asyncIterator]();
  };
  // TypeScript private fields remain ordinary JS properties in the published SDK.
  sandbox.pty.rpc = {
    start: (request, options) => open("start", request, options),
    connect: (request, options) => open("connect", request, options),
    async sendInput(request) {
      calls.push({ method: "input", request });
    },
    async update(request) {
      calls.push({ method: "resize", request });
    },
    async sendSignal(request) {
      calls.push({ method: "kill", request });
    },
  };
  return { sandbox, calls, streams, signals };
}

async function checkPackage(name, expectedVersion) {
  const packageRoot = resolve(sdkRoot, "node_modules", name);
  const metadata = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  assert.equal(metadata.version, expectedVersion);
  const { Sandbox } = await import(pathToFileURL(resolve(packageRoot, "dist/index.mjs")));
  const checks = [];
  const check = async (name, run) => {
    await run();
    checks.push(name);
  };

  await check(
    "PTY starts bash with a 60-second RPC stream deadline, no launch command or dedupe key",
    async () => {
      const f = fixture(Sandbox);
      const handle = await f.sandbox.pty.create({ cols: 80, rows: 24, onData() {} });
      assert.deepEqual(f.calls[0], {
        method: "start",
        request: {
          process: {
            cmd: "/bin/bash",
            args: ["-i", "-l"],
            envs: { TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
            cwd: undefined,
          },
          pty: { size: { cols: 80, rows: 24 } },
        },
        timeoutMs: 60_000,
      });
      await handle.disconnect();
      assert.equal(f.signals[0].aborted, true);
      f.streams[0].close();
      await assert.rejects(handle.wait(), /without a result/);
      assert.equal(handle.exitCode, undefined);
      assert.equal(f.calls.filter((call) => call.method === "kill").length, 0);
    },
  );

  await check(
    "Binary PTY callbacks are not stdout history; late callbacks stop after detach",
    async () => {
      const f = fixture(Sandbox);
      const output = [];
      const handle = await f.sandbox.pty.create({
        cols: 80,
        rows: 24,
        timeoutMs: 0,
        onData: (data) => output.push([...data]),
      });
      assert.equal(f.calls[0].timeoutMs, 0);
      f.streams[0].push(
        event("data", { output: { case: "pty", value: new Uint8Array([0, 255, 27]) } }),
      );
      await tick();
      assert.deepEqual(output, [[0, 255, 27]]);
      assert.equal(handle.stdout, "");
      await handle.disconnect();
      f.streams[0].push(event("data", { output: { case: "pty", value: bytes("late") } }));
      f.streams[0].close();
      await tick();
      assert.deepEqual(output, [[0, 255, 27]]);
      await assert.rejects(handle.wait(), /without a result/);
    },
  );

  await check("An end event followed by stream completion provides the exit result", async () => {
    const f = fixture(Sandbox);
    const handle = await f.sandbox.pty.create({ cols: 80, rows: 24, onData() {} });
    f.streams[0].push(event("end", { exitCode: 0, error: "" }));
    f.streams[0].close();
    assert.equal((await handle.wait()).exitCode, 0);
    assert.equal(handle.exitCode, 0);
  });

  await check(
    "PTY reconnect sends PID only, without cursor, ownership nonce, or controller fencing",
    async () => {
      const f = fixture(Sandbox);
      const first = await f.sandbox.pty.connect(481, { timeoutMs: 0, onData() {} });
      const second = await f.sandbox.pty.connect(481, { timeoutMs: 0, onData() {} });
      assert.deepEqual(f.calls[0].request, { process: { selector: { case: "pid", value: 481 } } });
      await first.disconnect();
      await f.sandbox.pty.kill(481);
      await f.sandbox.pty.sendInput(481, bytes("synthetic-input"));
      await f.sandbox.pty.resize(481, { cols: 120, rows: 40 });
      assert.deepEqual(
        f.calls.map((call) => call.method),
        ["connect", "connect", "kill", "input", "resize"],
      );
      await second.disconnect();
      for (const output of f.streams) output.close();
      await Promise.all([assert.rejects(first.wait()), assert.rejects(second.wait())]);
    },
  );

  await check("A caller abort remains attached after the PTY handshake", async () => {
    const f = fixture(Sandbox);
    const controller = new AbortController();
    const handle = await f.sandbox.pty.create({
      cols: 80,
      rows: 24,
      timeoutMs: 0,
      signal: controller.signal,
      onData() {},
    });
    assert.equal(f.signals[0].aborted, false);
    controller.abort();
    assert.equal(f.signals[0].aborted, true);
    f.streams[0].close();
    await assert.rejects(handle.wait());
  });

  await check(
    "Git clone puts a synthetic token in command text despite dangerouslyStoreCredentials false",
    async () => {
      const f = fixture(Sandbox);
      const commands = [];
      f.sandbox.commands.run = async (command) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      };
      await f.sandbox.git.clone("https://github.com/example/fixture.git", {
        username: "x-access-token",
        password: "SYNTHETIC_TOKEN",
        path: "/tmp/fixture",
        dangerouslyStoreCredentials: false,
      });
      assert.equal(commands.length, 2);
      assert.equal(commands[0].includes("SYNTHETIC_TOKEN"), true);
      assert.equal(commands[1].includes("SYNTHETIC_TOKEN"), false);
      assert.match(commands[1], /remote.*set-url/);
      commands.length = 0;
      f.sandbox.commands.run = async (command) => {
        commands.push(command);
        throw new Error("Synthetic lost clone response");
      };
      await assert.rejects(
        f.sandbox.git.clone("https://github.com/example/fixture.git", {
          username: "x-access-token",
          password: "SYNTHETIC_TOKEN",
          path: "/tmp/fixture",
          dangerouslyStoreCredentials: false,
        }),
        /Synthetic lost clone response/,
      );
      assert.equal(commands.length, 1);
      assert.equal(commands[0].includes("SYNTHETIC_TOKEN"), true);
    },
  );

  return { version: expectedVersion, checks };
}

const results = [];
for (const [name, version] of [
  ["e2b-old", "2.46.0"],
  ["e2b", "2.46.1"],
]) {
  results.push(await checkPackage(name, version));
}
assert.equal(networkAttempts, 0);
console.log(
  JSON.stringify(
    {
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      networkAttempts,
      evidence: "real SDK with in-memory RPC and Git command fakes; no provider guarantee measured",
      results,
    },
    null,
    2,
  ),
);
