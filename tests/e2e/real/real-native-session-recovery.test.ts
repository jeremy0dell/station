import type { WorktreeRow } from "@station/contracts";
import { describe, expect, it } from "vitest";
import { findRowByBranch } from "../../support/real-station/assertions";
import {
  type ClaudeHookFixture,
  continuePastClaudeTrustDialog,
  createClaudeSentinel,
  installClaudeHookProjectConfig,
  readClaudeSessionStartWitness,
  waitForClaudeSentinel,
} from "../../support/real-station/claude";
import {
  type CodexHookFixture,
  continuePastCodexStartupPrompts,
  createCodexSentinel,
  createRealCodexFixture,
  readCodexSessionStartWitness,
  waitForCodexSentinel,
  writeFailureBundle,
} from "../../support/real-station/codex";
import {
  type RealStationConfigFixture,
  writeRealStationConfig,
} from "../../support/real-station/config";
import {
  type RealE2eEnvironment,
  realE2eEnabled,
  requireRealE2eEnvironment,
} from "../../support/real-station/env";
import { CleanupStack, runStationJson } from "../../support/real-station/process";
import {
  createRealObserverClient,
  waitForCommandRecord,
} from "../../support/real-station/protocol";
import {
  createRealIngressWitness,
  launchProvenDormantRecovery,
  type ProviderSessionStartWitness,
  type RealIngressWitness,
  waitForResumedRecovery,
} from "../../support/real-station/recovery";
import {
  createRealTempRepo,
  type RealTempRepo,
  uniqueBranch,
} from "../../support/real-station/repo";
import { closeRealTmuxEndpoint } from "../../support/real-station/tmux";
import { removeRealWorktrunkWorktree } from "../../support/real-station/worktrunk";

type RecoveryProvider = "codex" | "claude";

const cases: Array<{ provider: RecoveryProvider; enabled: boolean }> = [
  { provider: "codex", enabled: realE2eEnabled() },
  {
    provider: "claude",
    enabled: realE2eEnabled() && process.env.STATION_REAL_CLAUDE === "1",
  },
];

describe.each(cases)("real $provider native session recovery", (testCase) => {
  const realIt = testCase.enabled ? it : it.skip;

  realIt(
    "resumes the exact provider-native identity after exact terminal loss",
    async () => {
      const cleanup = new CleanupStack();
      const baseEnv = await requireRealE2eEnvironment({
        worktrunk: true,
        tmux: true,
        ...(testCase.provider === "codex" ? { codex: true } : { claude: true }),
      });
      const repo = await createRealTempRepo(baseEnv);
      cleanup.defer(repo.cleanup);
      const ingress = await createRealIngressWitness({ env: baseEnv, rootPath: repo.root });
      const fixture = await prepareProvider(testCase.provider, ingress, repo);
      const { config, env } = fixture;
      const branch = uniqueBranch(`${testCase.provider}-native-recovery`);
      cleanup.defer(async () => {
        await removeRealWorktrunkWorktree({ env, config, repo, branch });
      });
      cleanup.defer(() => closeRealTmuxEndpoint(config.tmuxEndpoint));
      cleanup.defer(async () => {
        await runStationJson(env, {
          configPath: config.configPath,
          args: ["observer", "stop"],
        });
      });
      let commandId: string | undefined;

      try {
        await runStationJson(env, {
          configPath: config.configPath,
          args: ["observer", "start", "--timeout-ms", "30000"],
          timeoutMs: 45_000,
        });
        const client = createRealObserverClient(config, 30_000);
        const firstSentinel = fixture.createSentinel("recovery-before-loss");
        const proven = await launchProvenDormantRecovery({
          client,
          config,
          ingress,
          provider: testCase.provider,
          branch,
          initialPrompt: firstSentinel.prompt,
          afterTerminalAttached: async (row) => {
            await fixture.continueStartup(row);
            await fixture.waitForSentinel(firstSentinel, row.path);
          },
          readWitness: (row) => fixture.readSessionStart(row, "startup"),
          timeoutMs: 180_000,
        });
        commandId = proven.commandId;

        expect(proven.authority.witness.target).toEqual(proven.authority.handle.target);
        expect(proven.authority.execution?.nativeSessionId).toBe(
          nativeSessionId(proven.authority.witness),
        );
        expect(proven.row.recovery).toMatchObject({
          kind: "agent-resume",
          handleId: proven.authority.handle.id,
          provider: testCase.provider,
          sessionId: proven.identity.sessionId,
        });

        const followUpSentinel = fixture.createSentinel("recovery-after-loss");
        const resumeReceipt = await client.dispatch({
          type: "session.resumeAgent",
          payload: {
            projectId: proven.identity.projectId,
            worktreeId: proven.identity.worktreeId,
            recoveryHandleId: proven.authority.handle.id,
            terminal: { provider: "tmux", layout: "agent-build-shell" },
            initialPrompt: followUpSentinel.prompt,
          },
        });
        commandId = resumeReceipt.commandId;
        await expect(
          waitForCommandRecord(client, resumeReceipt.commandId, { timeoutMs: 180_000 }),
        ).resolves.toMatchObject({ status: "succeeded" });

        const resumed = await waitForResumedRecovery({
          client,
          stateDir: config.stateDir,
          identity: proven.identity,
          original: proven.authority.witness,
          readPostResumeWitness: () =>
            fixture.readSessionStart(proven.row, "resume", {
              invokedAfter: proven.loss.lostAt,
              nativeSessionId: nativeSessionId(proven.authority.witness),
            }),
          timeoutMs: 180_000,
        });
        expect(resumed.row.agent).toMatchObject({
          harness: testCase.provider,
          sessionId: proven.identity.sessionId,
        });
        expect(findRowByBranch(resumed.snapshot, branch).id).toBe(proven.identity.worktreeId);
        await fixture.waitForSentinel(followUpSentinel, resumed.row.path);
      } catch (error) {
        await writeFailureBundle({ env, configPath: config.configPath, commandId });
        throw error;
      } finally {
        await cleanup.run();
      }
    },
    420_000,
  );
});

type Sentinel = { prompt: string; relativePath: string; absolutePath: string; token: string };

type ProviderFixture = {
  env: RealE2eEnvironment;
  config: RealStationConfigFixture;
  createSentinel(label: string): Sentinel;
  waitForSentinel(sentinel: Sentinel, rootPath: string): Promise<void>;
  continueStartup(row: WorktreeRow): Promise<void>;
  readSessionStart(
    row: WorktreeRow,
    source: string,
    filters?: { invokedAfter?: string; nativeSessionId?: string },
  ): Promise<ProviderSessionStartWitness | undefined>;
};

async function prepareProvider(
  provider: RecoveryProvider,
  ingress: RealIngressWitness,
  repo: RealTempRepo,
): Promise<ProviderFixture> {
  if (provider === "codex") {
    const codex = await createRealCodexFixture({ env: ingress.env, repo });
    const config = await writeRealStationConfig({
      env: codex.env,
      repo,
      codexCommand: codex.codexCommand,
      installCodexHooks: true,
      recovery: true,
    });
    const hooks = await codex.installHooks(config);
    return codexProviderFixture(codex.env, config, ingress, hooks, repo);
  }

  const config = await writeRealStationConfig({
    env: ingress.env,
    repo,
    harnessProvider: "claude",
    installClaudeHooks: true,
    recovery: true,
  });
  const hooks = await installClaudeHookProjectConfig({
    env: ingress.env,
    repo,
    configPath: config.configPath,
  });
  return claudeProviderFixture(ingress.env, config, ingress, hooks, repo);
}

function codexProviderFixture(
  env: RealE2eEnvironment,
  config: RealStationConfigFixture,
  ingress: RealIngressWitness,
  hooks: CodexHookFixture,
  repo: RealTempRepo,
): ProviderFixture {
  return {
    env,
    config,
    createSentinel: (label) => createCodexSentinel(repo, label),
    waitForSentinel: (sentinel, rootPath) =>
      waitForCodexSentinel(sentinel, { rootPath, timeoutMs: 240_000 }),
    continueStartup: (row) =>
      continuePastCodexStartupPrompts(config.tmuxEndpoint, config.tmuxSession, row),
    readSessionStart: (row, source, filters = {}) =>
      readCodexSessionStartWitness({
        ingress,
        hooks,
        cwd: row.path,
        source: source === "resume" ? "resume" : "startup",
        ...(filters.invokedAfter === undefined ? {} : { invokedAfter: filters.invokedAfter }),
        ...(filters.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: filters.nativeSessionId }),
      }),
  };
}

function claudeProviderFixture(
  env: RealE2eEnvironment,
  config: RealStationConfigFixture,
  ingress: RealIngressWitness,
  hooks: ClaudeHookFixture,
  repo: RealTempRepo,
): ProviderFixture {
  return {
    env,
    config,
    createSentinel: (label) => createClaudeSentinel(repo, label),
    waitForSentinel: (sentinel, rootPath) =>
      waitForClaudeSentinel(sentinel, { rootPath, timeoutMs: 240_000 }),
    continueStartup: (row) =>
      continuePastClaudeTrustDialog(config.tmuxEndpoint, config.tmuxSession, row),
    readSessionStart: (row, source, filters = {}) =>
      readClaudeSessionStartWitness({
        ingress,
        hooks,
        cwd: row.path,
        source,
        ...(filters.invokedAfter === undefined ? {} : { invokedAfter: filters.invokedAfter }),
        ...(filters.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: filters.nativeSessionId }),
      }),
  };
}

function nativeSessionId(witness: ProviderSessionStartWitness): string {
  if (witness.target.kind !== "native-session") {
    throw new Error(`Expected native-session recovery, received ${witness.target.kind}.`);
  }
  return witness.target.id;
}
