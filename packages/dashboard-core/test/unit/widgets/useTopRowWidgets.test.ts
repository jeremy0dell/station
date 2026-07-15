import type { TuiWidgetConfig } from "@station/config";
import { describe, expect, it, vi } from "vitest";
import {
  createUseTopRowWidgets,
  refreshPolledWidget,
  type TopRowWidgetHookRuntime,
} from "../../../src/widgets/useTopRowWidgets.js";

const ENTRY = {
  id: "weather:0",
  cacheKey: "weather:austin",
  refreshIntervalMs: 15 * 60_000,
  loading: { text: "ATX · --° ⏳" },
  error: { text: "ATX · --° 🫥" },
  load: async () => ({ text: "ATX · 72° ☀️" }),
};

describe("refreshPolledWidget", () => {
  it("serves a fresh cache entry without calling the client", async () => {
    const cachedView = { text: "ATX · 70° ☀️" };
    const cache = new Map([[ENTRY.cacheKey, { view: cachedView, fetchedAtMs: 1_000 }]]);
    const load = vi.fn();
    const views: Array<{ id: string; text: string }> = [];

    await refreshPolledWidget(
      { ...ENTRY, load },
      {
        cancelled: () => false,
        cache,
        nowMs: () => 1_000 + 60_000,
        setView: (id, view) => views.push({ id, text: view.text }),
      },
    );

    expect(load).not.toHaveBeenCalled();
    expect(views).toEqual([{ id: ENTRY.id, text: cachedView.text }]);
  });

  it("refetches and re-caches once the entry is older than the refresh interval", async () => {
    const staleView = { text: "ATX · 72° ☀️" };
    const freshView = { text: "ATX · 50° ☁️" };
    const cache = new Map([[ENTRY.cacheKey, { view: staleView, fetchedAtMs: 0 }]]);
    const load = vi.fn().mockResolvedValue(freshView);
    const views: string[] = [];

    await refreshPolledWidget(
      { ...ENTRY, load },
      {
        cancelled: () => false,
        cache,
        nowMs: () => 16 * 60_000,
        setView: (_id, view) => views.push(view.text),
      },
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.get(ENTRY.cacheKey)?.view).toEqual(freshView);
    expect(views).toEqual([freshView.text]);
  });

  it("renders the entry's local error when loading rejects", async () => {
    const views: string[] = [];

    await refreshPolledWidget(
      { ...ENTRY, load: () => Promise.reject(new Error("boom")) },
      {
        cancelled: () => false,
        cache: new Map(),
        nowMs: () => 0,
        setView: (_id, view) => views.push(view.text),
      },
    );

    expect(views).toEqual([ENTRY.error.text]);
  });

  it("suppresses output when cancelled after the fetch resolves", async () => {
    const cache = new Map();
    const views: string[] = [];

    await refreshPolledWidget(ENTRY, {
      cancelled: () => true,
      cache,
      nowMs: () => 0,
      setView: (_id, view) => views.push(view.text),
    });

    expect(cache.size).toBe(0);
    expect(views).toEqual([]);
  });
});

// One synchronous render: state stays initial, effects never run — enough to
// assert the pure config → view mapping.
function renderOnce(widgets: readonly TuiWidgetConfig[], now: () => Date) {
  const hooks: TopRowWidgetHookRuntime = {
    useCallback: (callback) => callback,
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (initialValue) => ({ current: initialValue }),
    useState: (initialValue) => [
      typeof initialValue === "function" ? (initialValue as () => never)() : initialValue,
      () => {},
    ],
  };
  return createUseTopRowWidgets(hooks)(widgets, { now });
}

describe("useTopRowWidgets config mapping", () => {
  const noon = () => new Date(Date.UTC(2026, 5, 12, 12, 0));

  it("drops disabled widgets while ids keep the config index", () => {
    const views = renderOnce(
      [{ type: "time" }, { type: "time", enabled: false }, { type: "moon" }],
      noon,
    );
    expect(views.map((view) => view.id)).toEqual(["time:0", "moon:2"]);
  });

  it("emits snapshot placeholders for fleet and prs widgets", () => {
    const views = renderOnce([{ type: "fleet" }, { type: "prs" }], noon);
    expect(views).toEqual([
      { id: "fleet:0", text: "", data: "fleet" },
      { id: "prs:1", text: "", data: "prs" },
    ]);
  });

  it("keeps an AQI widget in configured order with its loading view", () => {
    const views = renderOnce(
      [{ type: "time" }, { type: "aqi", city: "Austin", label: "ATX" }, { type: "moon" }],
      noon,
    );
    expect(views[1]).toEqual({
      id: "aqi:1",
      text: "ATX · AQI -- ⏳",
      compact: "ATX AQI -- ⏳",
      attribution: {
        label: "Open-Meteo/CAMS",
        url: "https://open-meteo.com/",
      },
    });
  });

  it("keeps weather's original loading text without a compact form", () => {
    expect(renderOnce([{ type: "weather", city: "Austin", label: "ATX" }], noon)).toEqual([
      { id: "weather:0", text: "ATX · --° ⏳" },
    ]);
  });

  it("renders tz pairs and the moon phase from the shared clock", () => {
    const views = renderOnce(
      [
        {
          type: "tz",
          zones: [{ label: "NYC", timeZone: "America/New_York" }],
          timeFormat: "24h",
        },
        { type: "moon" },
      ],
      noon,
    );
    expect(views[0]?.text).toBe("NYC 08:00");
    expect(views[1]?.compact).toBe(views[1]?.text.split(" ")[0]);
  });
});
