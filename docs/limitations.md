# Limitations and Workarounds

Station v0.7 is a private preview. This page lists user-visible constraints and the available operational workaround for each one.

## Availability

Station is distributed through authenticated release assets in the private `jeremy0dell/station` repository. It is not available from a public package registry or public download page. The compiled binary supports macOS and Linux on arm64 and x64; Windows is not supported.

Use the authenticated installation procedure in [Install](install.md).

## Agent Status Can Be Conservative

Station reports only states that an agent harness can prove. A terminal-only session may remain **unknown** until a correlated hook or provider signal arrives, and status coverage differs by harness.

Use [Harnesses](harnesses.md) to compare coverage. When the displayed state appears stale, run:

```sh
stn doctor
stn snapshot --json
```

## External Sessions Cannot Always Be Focused

Station can display an agent discovered in a detached external terminal session, such as tmux, without being able to focus that terminal from the native workspace. Activating the row shows a notice naming where the agent is running.

Use `stn doctor` for the per-provider session breakdown, then attach through the terminal provider that owns the session.

## PTY Output Assumes UTF-8

The source-checkout `node-pty` bridge decodes terminal output as UTF-8. Invalid byte sequences become the replacement character (`�`), so legacy encodings and binary output do not render byte-for-byte.

Avoid sending binary data directly to a Station pane. Encode it first or write it to a file and inspect it with a binary-aware tool.

## Source-Checkout Panes Exit Immediately

A source checkout may show `terminal exited 1` when Bun installation clears the executable bit on node-pty's `spawn-helper`. Station repairs the bit before each spawn. If panes still exit immediately, run:

```sh
cd station
bun run repair:node-pty
```

Then relaunch the source checkout. This workaround does not apply to the compiled binary.

## The Station Button Pointer Can Disappear

The hand pointer over the floating Station button can disappear during hover even though the button remains usable. Open the dashboard with `Ctrl-O` or click the button normally.

## Diagnostic Retention Is Report-Only

`stn doctor` reports diagnostic file usage and retention limits, but Station does not automatically remove over-limit log and debug-bundle files. Review the reported state usage as part of routine diagnostics.

SQLite row retention is separate from diagnostic-file retention; see [Diagnostics](diagnostics.md) for the current behavior.

## Diagnostics Are CLI-First

The terminal workspace does not include a row-level debug inspector. Use `stn doctor`, `stn snapshot --json`, trace lookup, command records, and debug bundles for support evidence. Start with [Debugging](debugging.md) when you have a trace, command, or diagnostic ID.
