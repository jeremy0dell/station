# @station/harness-shared

Provider-neutral building blocks shared by the terminal harness adapters (claude, codex, cursor,
opencode, pi). Each adapter supplies provider-specific data plus a few callbacks; this
package supplies the uniform machinery so the adapters stay short and read top-to-bottom.

## Modules

| Module          | Responsibility                                                            |
| --------------- | ------------------------------------------------------------------------- |
| `provider.ts`   | `createTerminalBoundHarnessProvider(spec, options)` → `HarnessProvider`   |
| `hookAdapter.ts`| admit, compact, and map raw hooks to `HarnessEventReport`                 |
| `events.ts`     | build provider-neutral report diagnostics and correlation evidence        |
| `launch.ts`     | shared launch env + provider-data builders                                |
| `compaction.ts` | shrink large provider payloads to byte-bounded summaries                  |
| `errors.ts`     | `HarnessProviderError` + typed wrappers                                    |

## Provider assembly

An adapter exposes `createXHarnessProvider(options)`; it hands a `spec` (provider data + callbacks)
to the factory, which assembles the uniform interface methods.

```
  observer/CLI ──createXHarnessProvider(options)──► integrations/harness/<x>
                                                       │ spec (data + callbacks)
                                                       ▼
                       createTerminalBoundHarnessProvider(spec, options)
                       └─ capabilities · health · discoverRuns
                          · buildLaunch    (uniform, from this package)
```

The spec carries only what differs between harnesses: the command (env var + fallback),
`baseCapabilities`, the health probe args + diagnostics, `buildLaunch`, the provider-specific
unknown-status reason used during terminal-bound discovery, and optional
`doctorChecks`/`hooksStatus`/`acceptsPersistedEvent` callbacks. Optional interface methods
are attached only when the spec supplies them, so callers can feature-detect them.

## Runtime event flow

```
  raw ProviderHookEvent
     │  ProviderHookAdapter admission + compaction  (provider-specific)
     ▼
  provider report mapper
     │  preserve explicit Station/native identity and cwd evidence
     ▼
  HarnessEventReport
     │  Observer report ingestion + graph projection
     ▼
  HarnessEventObservation / current snapshot
```

`HarnessProvider` has no raw-event ingestion method. Raw hooks normalize only through the
registered hook adapter; already-typed reports enter Observer report ingestion directly.
