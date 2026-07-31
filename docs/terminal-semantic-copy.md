# Terminal Semantic Copy

Status: Station protocol version 1 is implemented; child-renderer adoption is opt-in.

Station pane drag selection distinguishes terminal-generated wraps, cooperating
application wraps, and hard line boundaries without inspecting provider events or
transcripts. The producing renderer is the only layer that knows whether a painted
row continues source text, so Station accepts a bounded row-boundary protocol rather
than guessing from pane width or output content.

## Product behavior

Plain drag-copy inside a native Station pane:

- joins xterm-native soft wraps without a newline;
- joins marked application continuations without a newline;
- preserves marked and unmarked genuine hard boundaries as newlines;
- omits renderer prefixes from marked hard and continuation rows;
- preserves unmarked child-TUI rows rather than guessing.

All harness providers hosted in a Station pane use this same extraction path; there
is no Pi-specific or non-Pi clipboard adapter. The drag release copies immediately
through Station's clipboard sinks. OpenTUI `Ctrl-C` handles its own non-pane text
selection and falls through for a pane-owned selection. An outer terminal's
Shift/Ctrl selection and application-owned copy commands bypass pane row metadata;
Pi's whole-message `Ctrl-X` behavior is unchanged.

## Capability

Every newly spawned Station-owned child PTY receives:

```text
TERM_PROGRAM=Station
STATION_SEMANTIC_COPY=1
```

Both values are generated at the final local, Bun, or Station Host PTY boundary.
They are not user configuration and launch input cannot replace them. Existing PTYs
retain the environment captured when they were spawned.

A cooperating child must require both exact values. It must not emit Station markers
through a known but unverified intervening multiplexer. Old and unsupported children
ignore the capability and retain hard-row copy behavior.

## Version 1 wire marker

A renderer writes one of these sequences immediately before semantic content:

```text
OSC 6973 ; station-copy ; 1 ; hard ST
OSC 6973 ; station-copy ; 1 ; <separator-space-count> ST
```

`hard` marks a genuine source boundary while identifying a render-only prefix to
omit. The numeric form identifies a synthetic continuation; its ASCII decimal value
from `0` through `1024` is the number of source spaces consumed by wrapping. Station
derives the semantic content column from xterm's cursor when either marker is parsed.
Visual indentation, borders, list markers, and component padding therefore remain
visible before the marker without entering Station's clipboard output.

The markers can only:

- preserve a hard boundary or continue the previous row;
- omit the visible prefix before marked semantic content;
- right-trim renderer padding from the previous row;
- restore a continuation's declared count of consumed ASCII spaces.

They cannot insert arbitrary text or copy by themselves. Malformed, unsupported, and
oversized OSC 6973 payloads are consumed invisibly and ignored. Diagnostics must not
include the payload.

Native xterm `isWrapped` state has precedence over an application marker. No marker
means a hard line boundary.

## VT and replay ownership

One semantic-copy state helper is installed on both the pane's `StationVtScreen` and
the Station Host's headless semantic terminal. It uses xterm-owned line markers so
hard/soft row metadata follows normal scrollback, alternate-buffer scrolling, line
insertion, line deletion, resize reflow, and eviction. Row erase, display erase,
DECSTR, RIS, and buffer clearing remove stale state.

Complete Host replay contains the original OSC bytes, so it carries no separate
sidecar. When raw history has been evicted, Host protocol 6 carries one
`serializedVt` payload and one `semanticCopy` sidecar containing only bounded normal-
and alternate-buffer row numbers, hard/soft kinds, prefix columns, and soft-row
separator counts. This variant-specific shape cannot represent a missing, duplicated,
or out-of-order sidecar; the strict row union cannot put separator spaces on a hard
row. An explicit empty sidecar clears stale state. Station parses the VT to idle before
restoring the sidecar and before queued live frames or pane-geometry recovery.

A sidecar row that no longer maps to the restored buffer is dropped with a
content-free terminal diagnostic; the live PTY remains attached. Control-only live
reset recovery uses RIS and contains neither history nor a semantic-copy sidecar.

## Privacy and security

- Selected text never enters Observer, Station Host metadata, provider integrations,
  or lifecycle events.
- Semantic snapshots contain only bounded enums and integers. Host geometry is
  constrained to 2–1000 columns and 1–1000 rows; normal-buffer rows are additionally bounded by the
  shared 10,000-line scrollback policy, while alternate rows and prefix columns must
  fit the replay geometry.
- Core and Station UI code never branch on harness or provider identity.
- The Pi lifecycle extension continues carrying correlation and lifecycle metadata
  only; it does not read session files or send transcript bodies.
- A marker affects only user-initiated pane selection and never invokes a clipboard
  sink itself.

## Child renderer guidance

The renderer should place a `hard` marker after render-only prefixes on each source
row and a numeric marker before semantic content on each synthetic continuation.
Literal `\n`, `\r\n`, and `\r` boundaries start new hard rows. Long-token splits use
zero separator spaces; word wrapping reports the exact number of consumed ASCII
spaces. ANSI styles and OSC 8 hyperlinks may surround either marker because they are
zero-width.

Pi support belongs in `@earendil-works/pi-tui`'s wrapping implementation, not in
Station's Pi lifecycle extension. The companion producer change covers Pi TUI text,
Markdown, code-block indentation, and other built-in wrappers. Station's currently
pinned Pi 0.80.10 fixture and installed Pi releases do not yet emit this protocol;
they remain launchable with row-preserving drag copy and application-owned copy
commands. Station should pin and document a supporting Pi release only after that
upstream release exists. Other child TUIs need equivalent producer support; Station
cannot infer an authored newline from an unmarked CRLF row without risking command
corruption.

Codex rich-output mode is one current example: it emits pre-wrapped rows and a two-column
visual gutter without semantic markers. Codex 0.146.0's `Alt-R` raw-output mode is an
independent workaround when enabled before the response is rendered. Raw mode omits the rich
gutter and leaves wrapping to the terminal, so Station can reconstruct it from native wrap
metadata; switching modes after output was rendered cannot restore boundary provenance.

## Manual verification

In a compatible child TUI inside a newly spawned native Station pane, drag-select a
long wrapped shell command and inspect the clipboard:

```bash
pbpaste | python3 -c 'import sys; s=sys.stdin.read(); print("line breaks:", s.count("\n") + s.count("\r")); print(repr(s))'
```

The wrapped command should report zero line breaks and no renderer gutter. A
two-source-line block should report exactly one. Repeat at narrow and wide pane widths,
after scrolling into history, after resizing, after complete Host reattach, and after
semantic recovery once the 256 KiB raw replay budget is exceeded. For the current Codex
workaround, press `Alt-R` before requesting the command and compare it with the same response
rendered in rich mode. Use an ordinary pane drag; Shift/Ctrl outer-terminal selection does not
exercise Station extraction.
