import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.deepEqual(
  Object.keys(process.env).filter((key) => key.startsWith("E2B_")),
  [],
);
const sdkRoot = resolve(process.argv[2]);
const accountKey = "SYNTHETIC_ACCOUNT_KEY";
const envdToken = "SYNTHETIC_ENVD_TOKEN";
const calls = [];
const serverErrors = [];
let inventoryBody = [];
let holdPty = false;
let heldResponse;
let deleteStatus = 204;
let deleteBody;
let dropCreate = false;

function frame(value, flags = 0) {
  const data = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, data]);
}

const sandboxInfo = {
  sandboxID: "offline-fixture",
  templateID: "base",
  envdVersion: "0.5.0",
  envdAccessToken: envdToken,
  domain: "example.invalid",
  metadata: {},
  state: "running",
  startedAt: "2026-09-07T00:00:00Z",
  endAt: "2026-09-07T00:05:00Z",
  cpuCount: 2,
  memoryMB: 512,
};

const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    assert.ok(raw.length < 65_536);
    const path = new URL(request.url, "http://localhost").pathname;
    const rpc = path.startsWith("/process.Process/");
    let body;
    if (raw.length) {
      if (request.headers["content-type"]?.startsWith("application/connect+json")) {
        assert.equal(raw[0], 0);
        assert.equal(raw.readUInt32BE(1), raw.length - 5);
        body = JSON.parse(raw.subarray(5));
      } else body = JSON.parse(raw);
    }
    calls.push({
      method: request.method,
      path,
      body,
      timeout: request.headers["connect-timeout-ms"],
    });
    if (rpc) {
      assert.equal(request.headers["x-access-token"], envdToken);
      assert.equal(request.headers["x-api-key"], undefined);
      assert.equal(raw.includes(accountKey), false);
      if (path.endsWith("/Start") || path.endsWith("/Connect")) {
        response.writeHead(200, { "Content-Type": "application/connect+json" });
        response.write(frame({ event: { start: { pid: 481 } } }));
        if (holdPty) {
          heldResponse = response;
          return;
        }
        response.write(
          frame({ event: { data: { pty: Buffer.from([0, 255, 27]).toString("base64") } } }),
        );
        response.write(
          frame({ event: { end: { exitCode: 0, exited: true, status: "exit status 0" } } }),
        );
        response.end(frame({}, 2));
      } else if (["/SendInput", "/Update", "/SendSignal"].some((method) => path.endsWith(method))) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      } else throw new Error("Unexpected process route");
      return;
    }
    assert.equal(request.headers["x-api-key"], accountKey);
    assert.equal(request.headers["x-access-token"], undefined);
    assert.equal(raw.includes(accountKey), false);
    response.setHeader("Content-Type", "application/json");
    if (path === "/v2/sandboxes") response.end(JSON.stringify(inventoryBody));
    else if (request.method === "DELETE") {
      response.statusCode = deleteStatus;
      response.end(deleteBody === undefined ? undefined : JSON.stringify(deleteBody));
    } else if (path.endsWith("/timeout")) {
      response.statusCode = 204;
      response.end();
    } else if (path === "/sandboxes" && dropCreate) response.destroy();
    else if (
      path === "/sandboxes" ||
      path === "/sandboxes/offline-fixture" ||
      path.endsWith("/connect")
    )
      response.end(JSON.stringify(sandboxInfo));
    else throw new Error("Unexpected lifecycle route");
  } catch (error) {
    serverErrors.push(error);
    response.destroy();
  }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  assert.equal(new URL(input instanceof Request ? input.url : input).origin, origin);
  return nativeFetch(input, init);
};
// Node's SDK uses undici directly; its request hook enforces the same loopback-only origin.
const requestChannel = channel("undici:request:create");
const checkOrigin = ({ request }) => assert.equal(new URL(request.origin).origin, origin);
requestChannel.subscribe(checkOrigin);

const results = [];
try {
  for (const [name, version] of [
    ["e2b-old", "2.46.0"],
    ["e2b", "2.46.1"],
  ]) {
    const packageRoot = resolve(sdkRoot, "node_modules", name);
    assert.equal(JSON.parse(await readFile(resolve(packageRoot, "package.json"))).version, version);
    const { Sandbox } = await import(pathToFileURL(resolve(packageRoot, "dist/index.mjs")));
    const options = {
      apiKey: accountKey,
      apiUrl: origin,
      sandboxUrl: origin,
      domain: "example.invalid",
      debug: false,
      requestTimeoutMs: 2_000,
    };
    const checks = [];

    const sandbox = await Sandbox.create("base", {
      ...options,
      timeoutMs: 10_001,
      allowInternetAccess: false,
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
    assert.equal(calls.at(-1).body.timeout, 11);
    assert.equal(calls.at(-1).body.allow_internet_access, false);
    assert.equal(calls.at(-1).body.secure, true);
    assert.equal(calls.at(-1).body.autoPause, false);
    assert.deepEqual(calls.at(-1).body.autoResume, { enabled: false });
    assert.equal(calls.at(-1).body.envVars, undefined);
    checks.push(
      "create rounds sandbox TTL up to whole seconds and keeps account key out of sandbox payload",
    );

    await Sandbox.connect("offline-fixture", options);
    assert.equal(calls.at(-1).method, "POST");
    assert.equal(calls.at(-1).path, "/sandboxes/offline-fixture/connect");
    assert.deepEqual(calls.at(-1).body, { timeout: 300 });
    await Sandbox.connect("offline-fixture", { ...options, timeoutMs: 1 });
    assert.deepEqual(calls.at(-1).body, { timeout: 1 });
    await Sandbox.setTimeout("offline-fixture", 10_001, options);
    assert.deepEqual(calls.at(-1).body, { timeout: 11 });
    checks.push(
      "connect sends a lifecycle POST with default 300-second requested TTL; timeout rounds up",
    );

    const info = await Sandbox.getInfo("offline-fixture", options);
    assert.equal(calls.at(-1).method, "GET");
    assert.equal(info.envdAccessToken, undefined);
    checks.push("getInfo is GET and strips the envd access token from its returned object");

    for (inventoryBody of [[], null]) {
      const paginator = Sandbox.list({ ...options, query: { state: ["running", "paused"] } });
      assert.deepEqual(await paginator.nextItems(), []);
      assert.equal(paginator.hasNext, false);
    }
    inventoryBody = [];
    checks.push("HTTP 200 JSON null inventory becomes the same empty completed list as JSON []");

    assert.equal(await Sandbox.kill("offline-fixture", options), true);
    deleteStatus = 404;
    deleteBody = { code: 404, message: "Synthetic not-found" };
    assert.equal(await Sandbox.kill("offline-fixture", options), false);
    deleteStatus = 403;
    assert.equal(await Sandbox.kill("offline-fixture", options), false);
    deleteStatus = 204;
    deleteBody = undefined;
    checks.push("kill maps an error body code 404 to false even when HTTP status is 403");

    dropCreate = true;
    const beforeDroppedCreate = calls.length;
    await assert.rejects(Sandbox.create("base", { ...options, timeoutMs: 30_000 }));
    assert.equal(calls.length - beforeDroppedCreate, 1);
    assert.equal(calls.at(-1).path, "/sandboxes");
    dropCreate = false;
    checks.push(
      "a create request with a dropped HTTP response rejects without an automatic create retry",
    );

    for (const timeoutMs of [undefined, 0]) {
      const output = [];
      const ptyOptions = { cols: 80, rows: 24, onData: (data) => output.push([...data]) };
      if (timeoutMs !== undefined) ptyOptions.timeoutMs = timeoutMs;
      const handle = await sandbox.pty.create(ptyOptions);
      assert.equal((await handle.wait()).exitCode, 0);
      const start = calls.at(-1);
      assert.equal(start.path, "/process.Process/Start");
      assert.equal(start.timeout, timeoutMs === 0 ? undefined : "60000");
      assert.equal(start.body.process.cmd, "/bin/bash");
      assert.deepEqual(start.body.process.args, ["-i", "-l"]);
      assert.equal(start.body.tag, undefined);
      assert.deepEqual(output, [[0, 255, 27]]);
    }
    checks.push(
      "real Connect HTTP sends a 60000-ms header by default; zero omits it and preserves binary bytes",
    );

    const connected = await sandbox.pty.connect(481, { timeoutMs: 0, onData() {} });
    assert.equal((await connected.wait()).exitCode, 0);
    assert.deepEqual(calls.at(-1).body, { process: { pid: 481 } });
    await sandbox.pty.sendInput(481, new Uint8Array([0, 255]));
    assert.equal(calls.at(-1).body.input.pty, "AP8=");
    await sandbox.pty.resize(481, { cols: 120, rows: 40 });
    assert.deepEqual(calls.at(-1).body.pty.size, { cols: 120, rows: 40 });
    assert.equal(await sandbox.pty.kill(481), true);
    checks.push("process connect/input/resize/kill use the sandbox token, not the account key");

    holdPty = true;
    const held = await sandbox.pty.connect(481, { timeoutMs: 0, onData() {} });
    assert.ok(heldResponse);
    const closed = once(heldResponse, "close");
    await held.disconnect();
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("local stream did not close")), 2_000);
        timer.unref();
      }),
    ]);
    await assert.rejects(held.wait());
    assert.equal(held.exitCode, undefined);
    holdPty = false;
    heldResponse = undefined;
    checks.push("detach closes an idle HTTP stream and wait rejects without authoritative exit");
    results.push({ version, checks });
  }
  assert.deepEqual(serverErrors, []);
} finally {
  requestChannel.unsubscribe(checkOrigin);
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
console.log(
  JSON.stringify(
    {
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      evidence:
        "real SDK HTTP transport against a loopback-only fake E2B server; no cloud or credentials",
      requests: calls.length,
      serverClosed: !server.listening,
      results,
    },
    null,
    2,
  ),
);
