# @station/harness-shared

Provider-neutral building blocks shared by the terminal harness adapters (claude, codex, cursor,
opencode, pi). Each adapter supplies provider-specific data plus a few callbacks; this
package supplies the uniform machinery so the adapters stay short and read top-to-bottom.

## Modules

| Module          | Responsibility                                                            |
| --------------- | ------------------------------------------------------------------------- |
| `catalog.ts`    | canonical built-in IDs, labels, command environment keys, and defaults    |
| `provider.ts`   | `createTerminalBoundHarnessProvider(spec, options)` → `HarnessProvider`   |
| `events.ts`     | correlate a raw harness event's identity to terminal/worktree truth       |
| `launch.ts`     | shared launch env + provider-data builders                                |
| `compaction.ts` | shrink large provider payloads to byte-bounded summaries                  |
| `errors.ts`     | `HarnessProviderError` + typed wrappers                                    |
| `classify.ts`   | map a harness run observation to a status                                 |

## Provider assembly

An adapter exposes `createXHarnessProvider(options)`; it hands a `spec` (provider data + callbacks)
to the factory, which assembles the uniform interface methods.

```
  observer/CLI ──createXHarnessProvider(options)──► integrations/harness/<x>
                                                       │ spec (data + callbacks)
                                                       ▼
                       createTerminalBoundHarnessProvider(spec, options)
                       └─ capabilities · health · discoverRuns · classifyRun
                          · ingestEvent · buildLaunch    (uniform, from this package)
```

The spec carries only what differs between harnesses: the command (env var + fallback),
`baseCapabilities`, the health probe args + diagnostics, `buildLaunch`/`classifyRun`/`normalize`,
and optional `doctorChecks`/`hooksStatus` callbacks. Optional interface methods are attached only
when the spec supplies them, so callers can feature-detect with `'doctorChecks' in provider`.

## Runtime event flow

```
  raw harness event
     │  adapter.normalize()                         (provider-specific parsing)
     ▼
  correlateTerminalBoundHarnessEvent(identity, context)   events.ts
     │  resolve terminal/worktree from hook identity + observed graph
     ▼
  applyCorrelation(observation, correlation)  +  compactPayloadByFieldNames()
     ▼
  HarnessEventObservation ──► observer
```
