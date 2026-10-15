import { describe, expect, it, vi } from "vitest";
import {
  createE2bPtyAdapter,
  fingerprintPtyConfig,
} from "../../scripts/spikes/e2b-pty-control.mjs";

const config = {
  scopeId: "station-481-isolated",
  sandboxTimeoutMs: 300_000,
  requestTimeoutMs: 30_000,
};
const executionId = "22222222-2222-4222-8222-222222222222";
const metadata = {
  station_owner: "station_e2b_spike",
  station_issue: "481",
  station_run_id: "11111111-1111-4111-8111-111111111111",
  station_execution_id: executionId,
  station_generation: "1",
  station_scope_id: config.scopeId,
  station_config_fingerprint: fingerprintPtyConfig(config),
};
const authority = {
  mode: "launch",
  sandboxId: "fixture-sandbox",
  expectedMetadata: metadata,
  workspacePath: `/workspace/station-481/${executionId}`,
  executionId,
  generation: 1,
  launchNonce: "33333333-3333-4333-8333-333333333333",
  sourceFingerprint: `sha256:${"b".repeat(64)}`,
};
const control = { ...authority, mode: "control", pid: 481 };
const cleanup = { ...authority, mode: "cleanup", pid: 481 };
const options = { signal: new AbortController().signal };
const attachmentOptions = { ...options, onData() {} };
const createOptions = { ...attachmentOptions, size: { cols: 120, rows: 40 } };
const bytes = new Uint8Array([65]);
const size = { cols: 100, rows: 30 };

function fixture() {
  const process = {
    pid: 481,
    cmd: "/bin/bash",
    args: ["-i", "-l"],
    envs: {
      STATION_E2B_EXECUTION_ID: executionId,
      STATION_E2B_GENERATION: "1",
      STATION_E2B_LAUNCH_NONCE: authority.launchNonce,
      STATION_E2B_SOURCE: authority.sourceFingerprint,
    },
    cwd: authority.workspacePath,
  };
  const processes: (typeof process)[] = [];
  const handles: ReturnType<typeof makeHandle>[] = [];
  function makeHandle() {
    const handle = {
      pid: 481,
      observeExit: vi.fn(async () => ({ kind: "transport_unproven" })),
      disconnect: vi.fn(async () => {}),
    };
    handles.push(handle);
    return handle;
  }
  const connection = {
    sandboxId: authority.sandboxId,
    list: vi.fn(async () => structuredClone(processes)),
    create: vi.fn(async (_options: { onData: (data: Uint8Array) => void | Promise<void> }) => {
      processes.push(structuredClone(process));
      return makeHandle();
    }),
    connectPty: vi.fn(async () => makeHandle()),
    sendInput: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    kill: vi.fn(async () => {
      processes.length = 0;
      return true;
    }),
  };
  const info = {
    sandboxId: authority.sandboxId,
    templateId: "base",
    metadata,
    startedAt: new Date(0),
    endAt: new Date(300_000),
    state: "running",
    cpuCount: 2,
    memoryMB: 512,
    envdVersion: "fixture",
    volumeMounts: [],
    allowInternetAccess: false,
    network: { allowOut: [], denyOut: ["0.0.0.0/0"], rules: {} },
    lifecycle: { onTimeout: "kill", autoResume: false },
    sandboxDomain: "e2b.app",
  };
  const api = {
    getInfo: vi.fn(async () => structuredClone(info)),
    connect: vi.fn(async () => connection),
  };
  const adapter = createE2bPtyAdapter(api, config, { nowEpochMs: () => 60_000 });
  return { adapter, api, connection, processes, process, handles, makeHandle, info };
}

async function activeFixture() {
  const f = fixture();
  const created = await f.adapter.create(authority, createOptions);
  expect(created.kind).toBe("created");
  expect(await created.attachment.activate()).toEqual({ kind: "active" });
  return { ...f, attachment: created.attachment };
}

async function expectRevoked(f: Awaited<ReturnType<typeof activeFixture>>) {
  expect(await f.attachment.sendInput(bytes, options)).toEqual({ kind: "control_revoked" });
  expect(await f.attachment.resize(size, options)).toEqual({ kind: "control_revoked" });
  expect(f.connection.sendInput).not.toHaveBeenCalled();
  expect(f.connection.resize).not.toHaveBeenCalled();
}

describe("isolated E2B PTY control", () => {
  it("never repeats create after a lost response and temporarily empty listing", async () => {
    const f = fixture();
    f.connection.create.mockImplementation(async () => {
      f.processes.push(structuredClone(f.process));
      throw new Error("lost fixture response");
    });
    f.connection.list.mockImplementation(async () => []);
    expect(await f.adapter.create(authority, createOptions)).toEqual({ kind: "request_uncertain" });
    expect(await f.adapter.create(authority, createOptions)).toEqual({ kind: "request_uncertain" });
    expect(f.connection.create).toHaveBeenCalledTimes(1);
    expect(f.processes).toHaveLength(1);
  });

  it.each(["sandbox", "pty"])("revokes active control after failed %s validation", async (kind) => {
    const f = await activeFixture();
    if (kind === "sandbox") f.info.metadata = { ...metadata, station_generation: "2" };
    else f.processes[0].envs.STATION_E2B_GENERATION = "2";
    expect(await f.adapter.connectExact(control, attachmentOptions)).toEqual({ kind: "conflict" });
    await expectRevoked(f);
  });

  it("revokes a returned pending attachment when Stop begins", async () => {
    const f = fixture();
    const created = await f.adapter.create(authority, createOptions);
    expect(created.kind).toBe("created");
    const stopped = f.adapter.stopExact(cleanup, options);
    expect(await created.attachment.activate()).toEqual({ kind: "control_revoked" });
    await stopped;
    expect(await created.attachment.sendInput(bytes, options)).toEqual({ kind: "control_revoked" });
    expect(f.connection.sendInput).not.toHaveBeenCalled();
    expect(f.connection.kill).toHaveBeenCalledTimes(1);
  });
});

it("reattaches the same PTY after the lost create response becomes observable", async () => {
  const f = fixture();
  f.connection.create.mockImplementationOnce(async () => {
    f.processes.push(structuredClone(f.process));
    throw new Error("lost fixture response");
  });
  expect(await f.adapter.create(authority, createOptions)).toEqual({ kind: "request_uncertain" });
  const attached = await f.adapter.connectExact(control, attachmentOptions);
  expect(attached.kind).toBe("connected");
  expect(attached.pid).toBe(481);
  expect(await attached.attachment.activate()).toEqual({ kind: "active" });
  expect(await attached.attachment.sendInput(bytes, options)).toEqual({
    kind: "request_succeeded",
  });
  expect(f.connection.create).toHaveBeenCalledTimes(1);
  expect(f.connection.connectPty).toHaveBeenCalledTimes(1);
});

it("does not rearm create after confirmed creation and later process disappearance", async () => {
  const f = fixture();
  expect((await f.adapter.create(authority, createOptions)).kind).toBe("created");
  f.processes.length = 0;
  expect(await f.adapter.create(authority, createOptions)).toEqual({ kind: "request_uncertain" });
  expect(f.connection.create).toHaveBeenCalledTimes(1);
});

it.each([
  "scan",
  "connectExact",
])("revokes input and resize after %s observes absence", async (method) => {
  const f = await activeFixture();
  f.processes.length = 0;
  await f.adapter[method](control, method === "scan" ? options : attachmentOptions);
  await expectRevoked(f);
});

it.each([
  "reject",
  "paused",
  "network",
  "invalid",
])("revokes control when sandbox inspection is %s", async (failure) => {
  const f = await activeFixture();
  if (failure === "reject")
    f.api.getInfo.mockRejectedValueOnce(new Error("fixture provider detail"));
  if (failure === "paused") f.info.state = "paused";
  if (failure === "network") f.info.allowInternetAccess = true;
  if (failure === "invalid") f.info.cpuCount = -1;
  expect(await f.adapter.connectExact(control, attachmentOptions)).toEqual({ kind: "unproven" });
  await expectRevoked(f);
});

it("revokes control even when local detach fails", async () => {
  const f = await activeFixture();
  f.handles[0].disconnect.mockRejectedValue(new Error("fixture detach failure"));
  f.processes.length = 0;
  expect(await f.adapter.connectExact(control, attachmentOptions)).toEqual({ kind: "absent" });
  await expectRevoked(f);
});

it("revokes before waiting for exact Stop or its provider response", async () => {
  const f = await activeFixture();
  const gate = Promise.withResolvers<boolean>();
  f.connection.kill.mockImplementation(() => gate.promise);
  const stopped = f.adapter.stopExact(cleanup, options);
  await expectRevoked(f);
  gate.resolve(false);
  expect(await stopped).toEqual({ kind: "request_uncertain" });
  expect(await f.adapter.connectExact(control, attachmentOptions)).toEqual({
    kind: "control_revoked",
  });
  expect(f.connection.connectPty).not.toHaveBeenCalled();
});

it("refuses a late connect response after Stop and detaches its handle", async () => {
  const f = await activeFixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.connection.connectPty.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return f.makeHandle();
  });
  const connecting = f.adapter.connectExact(control, attachmentOptions);
  await entered.promise;
  const stopped = f.adapter.stopExact(cleanup, options);
  await expectRevoked(f);
  gate.resolve();
  expect(await connecting).toEqual({ kind: "control_revoked" });
  await stopped;
  expect(f.handles[1].disconnect).toHaveBeenCalledTimes(1);
});

it("refuses a late create response after Stop without another create", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.connection.create.mockImplementationOnce(async () => {
    f.processes.push(structuredClone(f.process));
    entered.resolve();
    await gate.promise;
    return f.makeHandle();
  });
  const creating = f.adapter.create(authority, createOptions);
  await entered.promise;
  const stopped = f.adapter.stopExact(cleanup, options);
  gate.resolve();
  expect(await creating).toEqual({ kind: "control_revoked" });
  await stopped;
  expect(f.handles[0].disconnect).toHaveBeenCalledTimes(1);
  expect(f.connection.create).toHaveBeenCalledTimes(1);
  expect(f.connection.sendInput).not.toHaveBeenCalled();
});

it("cannot finish activation after Stop while buffered output is being delivered", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.connection.create.mockImplementationOnce(async (options) => {
    await options.onData(bytes);
    f.processes.push(structuredClone(f.process));
    return f.makeHandle();
  });
  const created = await f.adapter.create(authority, {
    ...createOptions,
    async onData() {
      entered.resolve();
      await gate.promise;
    },
  });
  const activating = created.attachment.activate();
  await entered.promise;
  const stopped = f.adapter.stopExact(cleanup, options);
  gate.resolve();
  expect(await activating).toEqual({ kind: "control_revoked" });
  await stopped;
  expect(await created.attachment.resize(size, options)).toEqual({ kind: "control_revoked" });
  expect(f.connection.resize).not.toHaveBeenCalled();
});

it("keeps input, resize, detach and same-PID reattach separate from Stop", async () => {
  const f = await activeFixture();
  expect(await f.attachment.sendInput(bytes, options)).toEqual({ kind: "request_succeeded" });
  expect(await f.attachment.resize(size, options)).toEqual({ kind: "request_succeeded" });
  expect(await f.attachment.disconnect()).toEqual({ kind: "detached" });
  expect(f.processes).toHaveLength(1);
  expect(f.connection.kill).not.toHaveBeenCalled();
  const connected = await f.adapter.connectExact(control, attachmentOptions);
  expect(connected.pid).toBe(481);
  expect(await connected.attachment.activate()).toEqual({ kind: "active" });
  expect(await f.attachment.sendInput(bytes, options)).toEqual({ kind: "control_revoked" });
  expect(await connected.attachment.sendInput(bytes, options)).toEqual({
    kind: "request_succeeded",
  });
  expect(f.connection.create).toHaveBeenCalledTimes(1);
});

it("does not turn transport loss into authoritative PTY exit", async () => {
  const f = await activeFixture();
  expect(await f.attachment.observeExit()).toEqual({ kind: "transport_unproven" });
  await expectRevoked(f);
  expect(f.processes).toHaveLength(1);
  expect(f.connection.kill).not.toHaveBeenCalled();
});

it("rejects provider accessors without invoking them", () => {
  const f = fixture();
  const getter = vi.fn(() => f.api.connect);
  const hostile = Object.defineProperty({ getInfo: f.api.getInfo }, "connect", { get: getter });
  expect(() => createE2bPtyAdapter(hostile, config)).toThrow("PTY_ADAPTER_INCOMPATIBLE");
  expect(getter).not.toHaveBeenCalled();
  expect(() => createE2bPtyAdapter(new Proxy(f.api, {}), config)).toThrow(
    "PTY_ADAPTER_INCOMPATIBLE",
  );
});

it("rejects process accessors and partial ownership without PTY mutation", async () => {
  const f = fixture();
  const getter = vi.fn(() => f.process.pid);
  const hostile = Object.defineProperty({ ...f.process }, "pid", { get: getter });
  f.connection.list.mockResolvedValueOnce([hostile]);
  expect(await f.adapter.create(authority, createOptions)).toEqual({ kind: "request_uncertain" });
  expect(getter).not.toHaveBeenCalled();
  f.processes.push({ ...f.process, envs: { ...f.process.envs, STATION_E2B_GENERATION: "" } });
  expect(await f.adapter.create(authority, createOptions)).toEqual({ kind: "conflict" });
  expect(f.connection.create).not.toHaveBeenCalled();
});

it("rejects duplicate exact PTYs without attaching or killing either", async () => {
  const f = fixture();
  f.processes.push(f.process, { ...f.process, pid: 482 });
  expect(await f.adapter.connectExact(control, attachmentOptions)).toEqual({ kind: "conflict" });
  expect(await f.adapter.stopExact(cleanup, options)).toEqual({ kind: "request_uncertain" });
  expect(f.connection.connectPty).not.toHaveBeenCalled();
  expect(f.connection.kill).not.toHaveBeenCalled();
});

it("rejects canceled and invalid create inputs before provider mutation", async () => {
  const f = fixture();
  expect(
    await f.adapter.create(authority, { ...createOptions, signal: AbortSignal.abort() }),
  ).toEqual({ kind: "request_uncertain" });
  expect(f.connection.create).not.toHaveBeenCalled();
  expect(f.api.connect).not.toHaveBeenCalled();
  const invalid = fixture();
  await expect(
    invalid.adapter.create(authority, { ...createOptions, size: { rows: 0, cols: 80 } }),
  ).rejects.toThrow("PTY_ADAPTER_INCOMPATIBLE");
  expect(invalid.api.connect).not.toHaveBeenCalled();
});

it("invalidates an attachment queued behind another handshake when Stop begins", async () => {
  const f = await activeFixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.connection.connectPty.mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return f.makeHandle();
  });
  const first = f.adapter.connectExact(control, attachmentOptions);
  await entered.promise;
  const queued = f.adapter.connectExact(control, attachmentOptions);
  const stopped = f.adapter.stopExact(cleanup, options);
  gate.resolve();
  expect(await first).toEqual({ kind: "control_revoked" });
  expect(await queued).toEqual({ kind: "control_revoked" });
  await stopped;
  expect(f.connection.connectPty).toHaveBeenCalledTimes(1);
  expect(f.connection.sendInput).not.toHaveBeenCalled();
});

it("serializes concurrent creates and consumes the attempt before a lost response", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  f.connection.create.mockImplementationOnce(async () => {
    f.processes.push(structuredClone(f.process));
    entered.resolve();
    await gate.promise;
    throw new Error("lost fixture response");
  });
  f.connection.list.mockImplementation(async () => []);
  const first = f.adapter.create(authority, createOptions);
  await entered.promise;
  const queued = f.adapter.create(authority, createOptions);
  gate.resolve();
  expect(await first).toEqual({ kind: "request_uncertain" });
  expect(await queued).toEqual({ kind: "control_revoked" });
  expect(await f.adapter.create(authority, createOptions)).toEqual({ kind: "request_uncertain" });
  expect(f.connection.create).toHaveBeenCalledTimes(1);
  expect(f.processes).toHaveLength(1);
});

it("revokes all pending attachments when validation fails", async () => {
  const f = fixture();
  const created = await f.adapter.create(authority, createOptions);
  const connected = await f.adapter.connectExact(control, attachmentOptions);
  f.processes.length = 0;
  await f.adapter.scan(control, options);
  expect(await created.attachment.activate()).toEqual({ kind: "control_revoked" });
  expect(await connected.attachment.activate()).toEqual({ kind: "control_revoked" });
  expect(f.handles.every((handle) => handle.disconnect.mock.calls.length === 1)).toBe(true);
  expect(f.connection.sendInput).not.toHaveBeenCalled();
});
