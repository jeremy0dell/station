import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dashboardCoreSourceDir = fileURLToPath(
  new URL("../../packages/dashboard-core/src", import.meta.url),
);

export const stationAliases = {
  "@station/cli/internal": fileURLToPath(
    new URL("../../apps/cli/src/internal.ts", import.meta.url),
  ),
  "@station/cli": fileURLToPath(new URL("../../apps/cli/src/index.ts", import.meta.url)),
  "@station/observer/internal": fileURLToPath(
    new URL("../../apps/observer/src/internal.ts", import.meta.url),
  ),
  "@station/observer": fileURLToPath(new URL("../../apps/observer/src/index.ts", import.meta.url)),
  "@station/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
  "@station/config": fileURLToPath(new URL("../../packages/config/src/index.ts", import.meta.url)),
  "@station/contracts": fileURLToPath(
    new URL("../../packages/contracts/src/index.ts", import.meta.url),
  ),
  "@station/dashboard-core": fileURLToPath(
    new URL("../../packages/dashboard-core/src/index.ts", import.meta.url),
  ),
  "@station/harness-shared": fileURLToPath(
    new URL("../../packages/harness-shared/src/index.ts", import.meta.url),
  ),
  "@station/claude": fileURLToPath(
    new URL("../../integrations/harness/claude/src/index.ts", import.meta.url),
  ),
  "@station/codex": fileURLToPath(
    new URL("../../integrations/harness/codex/src/index.ts", import.meta.url),
  ),
  "@station/cursor": fileURLToPath(
    new URL("../../integrations/harness/cursor/src/index.ts", import.meta.url),
  ),
  "@station/github-repository": fileURLToPath(
    new URL("../../integrations/repository/github/src/index.ts", import.meta.url),
  ),
  "@station/opencode": fileURLToPath(
    new URL("../../integrations/harness/opencode/src/index.ts", import.meta.url),
  ),
  "@station/observability": fileURLToPath(
    new URL("../../packages/observability/src/index.ts", import.meta.url),
  ),
  "@station/pi": fileURLToPath(
    new URL("../../integrations/harness/pi/src/index.ts", import.meta.url),
  ),
  "@station/provider-hooks": fileURLToPath(
    new URL("../../packages/provider-hooks/src/index.ts", import.meta.url),
  ),
  "@station/protocol": fileURLToPath(
    new URL("../../packages/protocol/src/index.ts", import.meta.url),
  ),
  "@station/runtime": fileURLToPath(
    new URL("../../packages/runtime/src/index.ts", import.meta.url),
  ),
  "@station/scripted-harness": fileURLToPath(
    new URL("../../integrations/harness/scripted/src/index.ts", import.meta.url),
  ),
  "@station/host": fileURLToPath(
    new URL("../../packages/station-host/src/index.ts", import.meta.url),
  ),
  "@station/testing": fileURLToPath(
    new URL("../../packages/testing/src/index.ts", import.meta.url),
  ),
  "@station/terminal": fileURLToPath(
    new URL("../../integrations/terminal/station/src/index.ts", import.meta.url),
  ),
  "@station/tmux": fileURLToPath(
    new URL("../../integrations/terminal/tmux/src/index.ts", import.meta.url),
  ),
  "@station/worktrunk": fileURLToPath(
    new URL("../../integrations/worktree/worktrunk/src/index.ts", import.meta.url),
  ),
};

export const commonResolveConfig = {
  root: repoRoot,
  resolve: {
    alias: [
      { find: /^@station\/dashboard-core\/(.+)$/, replacement: `${dashboardCoreSourceDir}/$1` },
      ...Object.entries(stationAliases).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
} as const;

export const commonTestConfig = {
  environment: "node",
  globals: false,
  passWithNoTests: false,
} as const;
