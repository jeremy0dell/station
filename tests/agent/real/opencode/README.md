# Real OpenCode Harness Tests

These tests exercise the real `opencode` binary, the generated local OpenCode plugin, the observer protocol server, tmux launch wiring, and provider-local OpenCode event normalization.

They are opt-in because they require a locally authenticated OpenCode setup:

```sh
STATION_REAL_E2E=1 STATION_REAL_OPENCODE=1 pnpm test:e2e:opencode:real
```

Set `STATION_OPENCODE_BIN=/path/to/opencode` to override the binary. Set `STATION_REAL_OPENCODE_KEEP_TEMP=1` to keep temporary test state after failures.
