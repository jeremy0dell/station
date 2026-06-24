import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { safeErrorFromUnknown } from "@station/runtime";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/**
 * While scrolled up: `freeze` preserves visible lines, `shift` preserves bottom
 * distance, and `follow` snaps live. At bottom, all modes track live output.
 */
export const SCROLL_ON_OUTPUT_MODES = ["freeze", "shift", "follow"] as const;
export type ScrollOnOutputMode = (typeof SCROLL_ON_OUTPUT_MODES)[number];

/**
 * One automation pane: split from `origin` or `previous`, write or execute its
 * command, and optionally focus it.
 */
const AutomationStepSchema = z
  .object({
    split: z.enum(["right", "below"]).default("right"),
    anchor: z.enum(["origin", "previous"]).default("previous"),
    command: z.string().min(1),
    run: z.enum(["execute", "write"]).default("execute"),
    focus: z.boolean().default(false),
  })
  .strict();

export type AutomationStep = z.infer<typeof AutomationStepSchema>;

/**
 * Named user-triggerable pane layout for the focused worktree; `enabled:false`
 * hides it from the context menu.
 */
const AutomationSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean().default(true),
    steps: z.array(AutomationStepSchema).min(1),
  })
  .strict();

export type Automation = z.infer<typeof AutomationSchema>;

// Inline the tmux `tmux-git-diffnav main` behavior so Station does not depend on
// a user-local helper script: merge-base diff, untracked files, unified watch UI.
const DEFAULT_DIFF_WATCH_COMMAND = [
  'base="$(git merge-base origin/main HEAD 2>/dev/null || true)"',
  '[ -n "$base" ] || base=HEAD',
  '{ git diff --no-color "$base" -- . || true; git ls-files --others --exclude-standard -- . | while IFS= read -r file; do [ -e "$file" ] || continue; printf "\\n"; git diff --no-color --no-index -- /dev/null "$file" || true; done; }',
].join("; ");

const DEFAULT_DELTA_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  "args=()",
  "wrap_width=80",
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -w=*) wrap_width="${1#-w=}"; args+=("$1"); shift ;;',
  '    -w|--width) wrap_width="$2"; args+=("$1" "$2"); shift 2 ;;',
  '    --width=*) wrap_width="${1#--width=}"; args+=("$1"); shift ;;',
  "    --max-line-length=*) shift ;;",
  "    --max-line-length) shift 2 ;;",
  '    *) args+=("$1"); shift ;;',
  "  esac",
  "done",
  'case "$wrap_width" in ""|*[!0-9]*) wrap_width=80 ;; esac',
  'if [ "$wrap_width" -gt 1 ]; then wrap_width=$((wrap_width - 1)); fi',
  '"$STATION_DIFFNAV_DELTA_BIN" "${args[@]}" --max-line-length=0 | perl -MEncode=decode -e \'binmode STDOUT, ":encoding(UTF-8)"; my $width = shift @ARGV; $width = 80 if !$width || $width < 1; while (defined(my $line = <STDIN>)) { $line = decode("UTF-8", $line, Encode::FB_DEFAULT); chomp $line; my $col = 0; while (length $line) { if ($line =~ s/^(\\e\\[[0-?]*[ -\\/]*[@-~])//) { print $1; next; } my $ch = substr($line, 0, 1, ""); if ($col >= $width) { print "\\n"; $col = 0; } print $ch; $col++; } print "\\n"; }\' "$wrap_width"',
].join("\n");

const DEFAULT_DIFF_COMMAND =
  [
    'delta_bin="$(command -v delta)"',
    'wrapper_dir="$(mktemp -d)"',
    `trap 'rm -rf "$wrapper_dir"' EXIT`,
  ].join(" && ") +
  ` && cat >"$wrapper_dir/delta" <<'STATION_DELTA_WRAP'\n${DEFAULT_DELTA_WRAPPER_SCRIPT}\nSTATION_DELTA_WRAP\n` +
  [
    'chmod +x "$wrapper_dir/delta"',
    [
      'STATION_DIFFNAV_DELTA_BIN="$delta_bin"',
      'PATH="$wrapper_dir:$PATH"',
      `DIFFNAV_CONFIG_DIR="\${DIFFNAV_CONFIG_DIR:-$HOME/.config/diffnav-tmux}"`,
      "diffnav --unified --watch",
      `--watch-cmd '${DEFAULT_DIFF_WATCH_COMMAND}'`,
      "--watch-interval 2s",
    ].join(" "),
  ].join(" && ");

const DEFAULT_DIFF_AUTOMATION: Automation = {
  id: "see-diff",
  label: "See diff (split right)",
  enabled: true,
  steps: [
    { split: "right", anchor: "origin", command: DEFAULT_DIFF_COMMAND, run: "execute", focus: true },
  ],
};

// Strict so a typo'd key or value surfaces as a warning instead of silently
// reverting to the default. Every field carries a default, so an empty or
// missing file parses to a fully-populated config.
const StationConfigSchema = z
  .object({
    scroll_on_output: z.enum(SCROLL_ON_OUTPUT_MODES).default("freeze"),
    // Show the welcome screen as an intro over the restored layout on every cold
    // boot; dismiss it to drop into your sessions. Off boots straight in.
    welcome_on_boot: z.boolean().default(true),
    // Named pane layouts in the pane context menu; defaults to the single diff automation so an empty
    // file still ships it. Ids must be unique: they key the menu rows and run-dispatch lookup, so a
    // duplicate would shadow a row and collide keys — reject (warn + defaults) rather than ship a dead item.
    automations: z
      .array(AutomationSchema)
      .superRefine((automations, ctx) => {
        const seen = new Set<string>();
        for (const automation of automations) {
          if (seen.has(automation.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `duplicate automation id "${automation.id}"`,
            });
          }
          seen.add(automation.id);
        }
      })
      .default([DEFAULT_DIFF_AUTOMATION]),
  })
  .strict();

export type StationConfig = z.infer<typeof StationConfigSchema>;

export const DEFAULT_STATION_CONFIG: StationConfig = StationConfigSchema.parse({});

export type StationConfigSource = "file" | "defaults";

export type StationConfigLoadResult = {
  config: StationConfig;
  source: StationConfigSource;
  /** Set when a present-but-broken file forced a fallback to defaults. */
  warning?: string;
};

/**
 * `~/.config/station/station.toml`, honoring `XDG_CONFIG_HOME`. Sibling of the
 * `~/.local/state/station` runtime state dir the rest of STATION uses.
 */
export function resolveStationConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  // The XDG spec says a relative XDG_CONFIG_HOME must be ignored, else config
  // resolution would depend on the process cwd.
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, "station", "station.toml");
}

/**
 * Parse + validate config text. A broken file never throws: it falls back to
 * defaults with a warning, so a bad edit degrades to default behavior rather
 * than refusing to start the TUI.
 */
export function parseStationConfig(source: string): {
  config: StationConfig;
  warning?: string;
} {
  let raw: unknown;
  try {
    raw = parseToml(source);
  } catch (cause) {
    const error = safeErrorFromUnknown(cause, {
      tag: "StationConfigError",
      code: "STATION_CONFIG_TOML_PARSE_FAILED",
      message: "station.toml is not valid TOML",
    });
    return {
      config: DEFAULT_STATION_CONFIG,
      warning: `${error.message}; using defaults.`,
    };
  }
  const result = StationConfigSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return {
      config: DEFAULT_STATION_CONFIG,
      warning: `station.toml has invalid fields (${detail}); using defaults.`,
    };
  }
  return { config: result.data };
}

export async function loadStationConfig(options?: {
  path?: string;
  env?: Record<string, string | undefined>;
}): Promise<StationConfigLoadResult> {
  const path = options?.path ?? resolveStationConfigPath(options?.env);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    // A missing file is the common case (no config written yet): silent
    // defaults. Any other read failure is surfaced as a warning.
    if (isNodeError(cause) && cause.code === "ENOENT") {
      return { config: DEFAULT_STATION_CONFIG, source: "defaults" };
    }
    const error = safeErrorFromUnknown(cause, {
      tag: "StationConfigError",
      code: "STATION_CONFIG_READ_FAILED",
      message: `Could not read ${path}`,
    });
    return {
      config: DEFAULT_STATION_CONFIG,
      source: "defaults",
      warning: `${error.message}; using defaults.`,
    };
  }
  const parsed = parseStationConfig(source);
  const result: StationConfigLoadResult = { config: parsed.config, source: "file" };
  if (parsed.warning !== undefined) {
    result.warning = parsed.warning;
  }
  return result;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
