import { describe, expect, it } from "bun:test";
import { CliRenderEvents } from "@opentui/core";
import { createStationThemeController, type StationThemeRenderer } from "./controller.js";
import { resolveEmbeddedStationTheme } from "./theme.js";
import {
  darkTerminalColors,
  lightTerminalColors,
  malformedTerminalColors,
} from "./test/fixtures.js";

type EventName = CliRenderEvents.PALETTE | CliRenderEvents.THEME_MODE;
type Listener = (payload: unknown) => void;

type Deferred = Readonly<{
  resolve(value: unknown): void;
  reject(error: unknown): void;
}>;

class FakeThemeRenderer implements StationThemeRenderer {
  readonly calls: string[] = [];
  readonly listeners = new Map<EventName, Set<Listener>>();
  private readonly responses: Array<() => Promise<unknown>> = [];

  enqueue(value: unknown): void {
    this.responses.push(() => Promise.resolve(value));
  }

  enqueueFailure(error: unknown): void {
    this.responses.push(() => Promise.reject(error));
  }

  enqueueDeferred(): Deferred {
    let resolvePromise: (value: unknown) => void = () => {};
    let rejectPromise: (error: unknown) => void = () => {};
    const response = new Promise<unknown>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.responses.push(() => response);
    return { resolve: resolvePromise, reject: rejectPromise };
  }

  getPalette(options: { size: 16 }): Promise<unknown> {
    this.calls.push(`get:${options.size}`);
    const response = this.responses.shift();
    if (response === undefined) {
      return Promise.reject(new Error("No fake palette response queued."));
    }
    return response();
  }

  clearPaletteCache(): void {
    this.calls.push("clear");
  }

  on(event: EventName, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: EventName, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emitPalette(value: unknown): void {
    for (const listener of this.listeners.get(CliRenderEvents.PALETTE) ?? []) {
      listener(value);
    }
  }

  emitThemeMode(): void {
    for (const listener of this.listeners.get(CliRenderEvents.THEME_MODE) ?? []) {
      listener("dark");
    }
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function backgroundSnapshot(controller: ReturnType<typeof createStationThemeController>): string {
  return controller.getSnapshot().terminal.defaultBackground.value;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 750;
  while (!assertion()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for controller state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("Station theme controller", () => {
  it("starts with a terminal-default embedded canvas", () => {
    const controller = createStationThemeController(new FakeThemeRenderer());

    expect(controller.getSnapshot()).toBe(resolveEmbeddedStationTheme(null));
    expect(controller.getSnapshot().surfaces.canvas).toMatchObject({
      kind: "terminal-default",
      channel: "background",
    });
  });

  it("publishes the initial valid observation", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    const controller = createStationThemeController(renderer);
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });

    await controller.start();

    expect(backgroundSnapshot(controller)).toBe(darkTerminalColors.defaultBackground);
    expect(notifications).toBe(1);
  });

  it("keeps the complete fallback for initial query failures and malformed results", async () => {
    const failedRenderer = new FakeThemeRenderer();
    failedRenderer.enqueueFailure(new Error("palette unavailable"));
    const failed = createStationThemeController(failedRenderer);
    await failed.start();
    expect(failed.getSnapshot()).toBe(resolveEmbeddedStationTheme(null));

    const malformedRenderer = new FakeThemeRenderer();
    malformedRenderer.enqueue(malformedTerminalColors);
    const malformed = createStationThemeController(malformedRenderer);
    await malformed.start();
    expect(malformed.getSnapshot()).toBe(resolveEmbeddedStationTheme(null));
  });

  it("recovers from a rejected query on the next theme invalidation", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueueFailure(new Error("palette unavailable"));
    const controller = createStationThemeController(renderer);
    await controller.start();
    expect(controller.getSnapshot()).toBe(resolveEmbeddedStationTheme(null));

    renderer.enqueue(darkTerminalColors);
    renderer.enqueue(lightTerminalColors);
    renderer.emitThemeMode();
    await waitFor(
      () => backgroundSnapshot(controller) === lightTerminalColors.defaultBackground,
    );

    expect(renderer.calls).toEqual(["get:16", "get:16", "clear", "get:16"]);
  });

  it("does not notify for canonically equal observations", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    const controller = createStationThemeController(renderer);
    let notifications = 0;
    controller.subscribe(() => {
      notifications += 1;
    });
    await controller.start();

    renderer.emitPalette({
      ...darkTerminalColors,
      palette: darkTerminalColors.palette.map((value) => value.toUpperCase()),
      defaultForeground: darkTerminalColors.defaultForeground.toUpperCase(),
      defaultBackground: darkTerminalColors.defaultBackground.toUpperCase(),
    });

    expect(notifications).toBe(1);
  });

  it("publishes palette events immediately", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    const controller = createStationThemeController(renderer);
    await controller.start();

    renderer.emitPalette(lightTerminalColors);

    expect(backgroundSnapshot(controller)).toBe(lightTerminalColors.defaultBackground);
  });

  it("treats theme mode as invalidation and re-observes colors", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    renderer.enqueue(darkTerminalColors);
    renderer.enqueue(lightTerminalColors);
    const controller = createStationThemeController(renderer);
    await controller.start();

    renderer.emitThemeMode();
    await waitFor(() => renderer.calls.filter((call) => call.startsWith("get:")).length === 3);
    await waitFor(
      () => backgroundSnapshot(controller) === lightTerminalColors.defaultBackground,
    );

    expect(renderer.calls).toEqual(["get:16", "get:16", "clear", "get:16"]);
  });

  it("coalesces repeated invalidations", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    const drain = renderer.enqueueDeferred();
    renderer.enqueue(lightTerminalColors);
    const controller = createStationThemeController(renderer);
    await controller.start();

    renderer.emitThemeMode();
    renderer.emitThemeMode();
    renderer.emitThemeMode();
    expect(renderer.calls.filter((call) => call.startsWith("get:")).length).toBe(2);

    drain.resolve(darkTerminalColors);
    await waitFor(
      () => backgroundSnapshot(controller) === lightTerminalColors.defaultBackground,
    );
    expect(renderer.calls.filter((call) => call.startsWith("get:")).length).toBe(3);
    expect(renderer.calls.filter((call) => call === "clear")).toHaveLength(1);
  });

  it("keeps burst palette events authoritative during an invalidated query", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    const drain = renderer.enqueueDeferred();
    renderer.enqueue(lightTerminalColors);
    const controller = createStationThemeController(renderer);
    await controller.start();

    renderer.emitThemeMode();
    renderer.emitPalette(lightTerminalColors);
    renderer.emitPalette(darkTerminalColors);
    renderer.emitPalette(lightTerminalColors);
    expect(backgroundSnapshot(controller)).toBe(lightTerminalColors.defaultBackground);

    drain.resolve(darkTerminalColors);
    await waitFor(() => renderer.calls.length === 4);

    expect(renderer.calls).toEqual(["get:16", "get:16", "clear", "get:16"]);
    expect(backgroundSnapshot(controller)).toBe(lightTerminalColors.defaultBackground);
  });

  it("does not let a stale initial query overwrite a newer palette event", async () => {
    const renderer = new FakeThemeRenderer();
    const initial = renderer.enqueueDeferred();
    const controller = createStationThemeController(renderer);
    const started = controller.start();

    renderer.emitPalette(lightTerminalColors);
    initial.resolve(darkTerminalColors);
    await started;

    expect(backgroundSnapshot(controller)).toBe(lightTerminalColors.defaultBackground);
  });

  it("clears the cache after an invalidated query settles before replacing it", async () => {
    const renderer = new FakeThemeRenderer();
    const initial = renderer.enqueueDeferred();
    renderer.enqueue(lightTerminalColors);
    const controller = createStationThemeController(renderer);
    const started = controller.start();

    renderer.emitThemeMode();
    expect(renderer.calls).toEqual(["get:16"]);
    initial.resolve(darkTerminalColors);
    await started;
    await waitFor(() => renderer.calls.length === 3);

    expect(renderer.calls).toEqual(["get:16", "clear", "get:16"]);
    expect(backgroundSnapshot(controller)).toBe(lightTerminalColors.defaultBackground);
  });

  it("removes both renderer listeners on disposal", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    const controller = createStationThemeController(renderer);
    await controller.start();

    controller.dispose();

    expect(renderer.listenerCount(CliRenderEvents.PALETTE)).toBe(0);
    expect(renderer.listenerCount(CliRenderEvents.THEME_MODE)).toBe(0);
  });

  it("ignores late query completion after disposal", async () => {
    const renderer = new FakeThemeRenderer();
    const initial = renderer.enqueueDeferred();
    const controller = createStationThemeController(renderer);
    const started = controller.start();

    controller.dispose();
    initial.resolve(darkTerminalColors);
    await started;

    expect(controller.getSnapshot()).toBe(resolveEmbeddedStationTheme(null));
  });

  it("makes repeated start and dispose calls safe", async () => {
    const renderer = new FakeThemeRenderer();
    renderer.enqueue(darkTerminalColors);
    const controller = createStationThemeController(renderer);

    await Promise.all([controller.start(), controller.start()]);
    expect(renderer.calls).toEqual(["get:16"]);
    expect(renderer.listenerCount(CliRenderEvents.PALETTE)).toBe(1);
    expect(renderer.listenerCount(CliRenderEvents.THEME_MODE)).toBe(1);

    controller.dispose();
    controller.dispose();
    await controller.start();
    expect(renderer.calls).toEqual(["get:16"]);
  });
});
