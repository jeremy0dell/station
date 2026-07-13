import type {
  ErrorEnvelope,
  ProviderProjectConfig,
  SafeError,
  SessionRecoveryHandle,
  StationCommand,
  StationEvent,
} from "@station/contracts";
import type { RuntimeClock } from "@station/runtime";
import {
  createFakeHarnessRun,
  createFakeTerminalTarget,
  createFakeWorktree,
} from "@station/testing";
import { describe, expect, it } from "vitest";
import type { ObserverPersistenceBundle } from "../../src/persistence/ports";
import type {
  ObserverIdFactory,
  RecordProviderObservationInput,
} from "../../src/persistence/types";

const earlier = "2026-05-20T11:59:00.000Z";
const now = "2026-05-20T12:00:00.000Z";
const later = "2026-05-20T12:01:00.000Z";
const latest = "2026-05-20T12:02:00.000Z";

const command: StationCommand = {
  type: "observer.reconcile",
  payload: { reason: "persistence-contract" },
};

const project: ProviderProjectConfig = {
  id: "web",
  label: "web",
  root: "/tmp/station/web",
  defaults: {
    harness: "fake-harness",
    terminal: "fake-terminal",
    layout: "agent-shell",
  },
  worktrunk: { enabled: true },
};

export type ObserverPersistenceContractFixture = {
  persistence: ObserverPersistenceBundle;
  close?: () => void | Promise<void>;
};

export type ObserverPersistenceContractFactory = (options: {
  clock: RuntimeClock;
  idFactory: ObserverIdFactory;
}) => ObserverPersistenceContractFixture | Promise<ObserverPersistenceContractFixture>;

type ContractOptions = {
  now?: string;
  idPrefix?: string;
  idFactory?: Partial<ObserverIdFactory>;
};

type ContractContext = {
  persistence: ObserverPersistenceBundle;
  setNow(value: string): void;
};

export function observerPersistenceContract(
  adapterName: string,
  createFixture: ObserverPersistenceContractFactory,
): void {
  describe(`${adapterName} Observer persistence contract`, () => {
    describe("CommandJournal", () => {
      it("persists the complete successful command lifecycle", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const accepted = await persistence.recordCommandAccepted({
            commandId: "cmd_lifecycle",
            command,
            createdAt: earlier,
            traceId: "trc_lifecycle",
            spanId: "spn_lifecycle",
          });
          expect(accepted).toEqual({
            id: "cmd_lifecycle",
            type: "observer.reconcile",
            command,
            status: "accepted",
            createdAt: earlier,
            traceId: "trc_lifecycle",
            spanId: "spn_lifecycle",
          });

          await expect(persistence.markCommandStarted("cmd_lifecycle", now)).resolves.toMatchObject(
            {
              id: "cmd_lifecycle",
              status: "started",
              startedAt: now,
            },
          );
          await expect(
            persistence.markCommandSucceeded("cmd_lifecycle", later),
          ).resolves.toMatchObject({
            id: "cmd_lifecycle",
            status: "succeeded",
            startedAt: now,
            finishedAt: later,
          });
          await expect(persistence.getCommand("cmd_lifecycle")).resolves.toMatchObject({
            id: "cmd_lifecycle",
            status: "succeeded",
          });
        });
      });

      it("persists failures, envelopes, and deduplicated diagnostics separately", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const diagnostic = {
            type: "external_command" as const,
            provider: "fake-harness",
            operation: "contract failure",
            command: "fake --fail",
            stderrSnippet: "private adapter detail",
          };
          const safeError = contractSafeError("COMMAND_FAILED");
          await persistence.recordCommandAccepted({
            commandId: "cmd_failed",
            command,
            createdAt: earlier,
          });
          await persistence.markCommandStarted("cmd_failed", now);
          await persistence.markCommandFailed({
            commandId: "cmd_failed",
            safeError,
            envelope: contractEnvelope({
              id: "err_z",
              commandId: "cmd_failed",
              createdAt: later,
              diagnostics: [diagnostic],
            }),
            finishedAt: later,
          });
          await persistence.markCommandFailed({
            commandId: "cmd_failed",
            safeError,
            envelope: contractEnvelope({
              id: "err_a",
              commandId: "cmd_failed",
              createdAt: later,
              diagnostics: [diagnostic],
            }),
            finishedAt: latest,
          });

          await expect(persistence.getCommand("cmd_failed")).resolves.toEqual(
            expect.objectContaining({
              status: "failed",
              error: safeError,
              diagnostics: [diagnostic],
            }),
          );
          expect((await persistence.listCommandErrors()).map((error) => error.id)).toEqual([
            "err_a",
            "err_z",
          ]);
          await expect(persistence.listCommandErrors("cmd_failed")).resolves.toHaveLength(2);
          await expect(persistence.listCommandErrors("cmd_other")).resolves.toEqual([]);
        });
      });

      it("orders commands by timestamp and ID", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          await persistence.recordCommandAccepted({
            commandId: "cmd_z",
            command,
            createdAt: now,
          });
          await persistence.recordCommandAccepted({
            commandId: "cmd_earlier",
            command,
            createdAt: earlier,
          });
          await persistence.recordCommandAccepted({
            commandId: "cmd_a",
            command,
            createdAt: now,
          });

          expect((await persistence.listCommands()).map((item) => item.id)).toEqual([
            "cmd_earlier",
            "cmd_a",
            "cmd_z",
          ]);
        });
      });

      it("rejects duplicate and invalid commands without changing prior state", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          await persistence.recordCommandAccepted({
            commandId: "cmd_duplicate",
            command,
            createdAt: now,
          });
          await expectPersistenceFailure(
            persistence.recordCommandAccepted({
              commandId: "cmd_duplicate",
              command: {
                type: "observer.reconcile",
                payload: { reason: "replacement" },
              },
              createdAt: later,
            }),
          );
          const invalid = {
            ...command,
            unexpected: true,
          } as unknown as StationCommand;
          await expectPersistenceFailure(
            persistence.recordCommandAccepted({
              commandId: "cmd_invalid",
              command: invalid,
              createdAt: later,
            }),
          );

          await expect(persistence.listCommands()).resolves.toEqual([
            expect.objectContaining({
              id: "cmd_duplicate",
              command,
              createdAt: now,
            }),
          ]);
        });
      });

      it("rejects every transition for a missing command and rolls back error insertion", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          await expectPersistenceFailure(persistence.markCommandStarted("cmd_missing", now));
          await expectPersistenceFailure(persistence.markCommandSucceeded("cmd_missing", now));
          await expectPersistenceFailure(
            persistence.markCommandFailed({
              commandId: "cmd_missing",
              safeError: contractSafeError("MISSING_COMMAND"),
              envelope: contractEnvelope({
                id: "err_missing",
                commandId: "cmd_missing",
                createdAt: now,
              }),
              finishedAt: now,
            }),
          );

          await expect(persistence.getCommand("cmd_missing")).resolves.toBeUndefined();
          await expect(persistence.listCommandErrors()).resolves.toEqual([]);
        });
      });
    });

    describe("EventJournal", () => {
      it("applies source, command, and timestamp defaults while preserving optional absence", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const timestamped = await persistence.recordEvent({
            type: "observer.started",
            at: earlier,
          });
          expect(timestamped).toEqual({
            id: "contract_evt_1",
            type: "observer.started",
            source: "observer",
            event: { type: "observer.started", at: earlier },
            createdAt: earlier,
          });

          const commandEvent = await persistence.recordEvent({
            type: "command.succeeded",
            commandId: "cmd_event",
          });
          expect(commandEvent).toEqual({
            id: "contract_evt_2",
            type: "command.succeeded",
            source: "observer",
            event: { type: "command.succeeded", commandId: "cmd_event" },
            createdAt: now,
            commandId: "cmd_event",
          });
          expect(commandEvent).not.toHaveProperty("traceId");
          expect(commandEvent).not.toHaveProperty("spanId");
        });
      });

      it("orders and filters events by command and type", async () => {
        await withPersistence(
          createFixture,
          async ({ persistence }) => {
            await persistence.recordEvent(
              { type: "observer.started", at: now },
              { createdAt: now },
            );
            await persistence.recordEvent(
              { type: "command.succeeded", commandId: "cmd_filter" },
              { createdAt: earlier },
            );
            await persistence.recordEvent(
              { type: "observer.started", at: now },
              { createdAt: now, source: "contract" },
            );

            expect((await persistence.listEvents()).map((event) => event.id)).toEqual([
              "evt_middle",
              "evt_a",
              "evt_z",
            ]);
            await expect(persistence.listEvents({ commandId: "cmd_filter" })).resolves.toEqual([
              expect.objectContaining({ id: "evt_middle" }),
            ]);
            expect(
              (await persistence.listEvents({ type: "observer.started" })).map((event) => event.id),
            ).toEqual(["evt_a", "evt_z"]);
          },
          {
            idFactory: {
              eventId: queuedIds(["evt_z", "evt_middle", "evt_a"]),
            },
          },
        );
      });

      it("rejects duplicate generated IDs and consumes the failed ID", async () => {
        await withPersistence(
          createFixture,
          async ({ persistence }) => {
            await persistence.recordEvent(
              { type: "observer.started", at: earlier },
              { createdAt: earlier },
            );
            await expectPersistenceFailure(
              persistence.recordEvent({ type: "observer.started", at: now }, { createdAt: now }),
            );
            const third = await persistence.recordEvent(
              { type: "observer.started", at: later },
              { createdAt: later },
            );

            expect(third.id).toBe("evt_after_duplicate");
            expect((await persistence.listEvents()).map((event) => event.id)).toEqual([
              "evt_duplicate",
              "evt_after_duplicate",
            ]);
          },
          {
            idFactory: {
              eventId: queuedIds(["evt_duplicate", "evt_duplicate", "evt_after_duplicate"]),
            },
          },
        );
      });

      it("strictly validates events before generating an ID", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const invalidEvent = {
            type: "observer.started",
            at: now,
            unexpected: true,
          } as unknown as StationEvent;
          await expectPersistenceFailure(persistence.recordEvent(invalidEvent));

          await expect(
            persistence.recordEvent({ type: "observer.started", at: now }),
          ).resolves.toMatchObject({ id: "contract_evt_1" });
          await expect(persistence.listEvents()).resolves.toHaveLength(1);
        });
      });
    });

    describe("IngressJournal", () => {
      it("deduplicates by the complete kind and ID pair", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const event = providerHookEvent("shared-id");
          const first = await persistence.recordEventWithIngressDedupe(event, {
            source: "hook",
            createdAt: now,
            dedupe: { kind: "hook", id: "shared-id" },
          });
          const duplicate = await persistence.recordEventWithIngressDedupe(event, {
            source: "hook",
            createdAt: now,
            dedupe: { kind: "hook", id: "shared-id" },
          });
          const otherKind = await persistence.recordEventWithIngressDedupe(event, {
            source: "hook",
            createdAt: now,
            dedupe: { kind: "harness_report", id: "shared-id" },
          });

          expect(first).toMatchObject({ deduped: false, event: { id: "contract_evt_1" } });
          expect(duplicate).toEqual({ deduped: true });
          expect(otherKind).toMatchObject({ deduped: false, event: { id: "contract_evt_3" } });
          expect((await persistence.listEvents()).map((item) => item.id)).toEqual([
            "contract_evt_1",
            "contract_evt_3",
          ]);
        });
      });

      it("rolls back an event-only claim when event persistence fails", async () => {
        await withPersistence(
          createFixture,
          async ({ persistence }) => {
            await persistence.recordEvent(
              { type: "observer.started", at: earlier },
              { createdAt: earlier },
            );
            const event = providerHookEvent("hook_event_retry");
            const options = {
              source: "hook",
              createdAt: now,
              dedupe: { kind: "hook" as const, id: "hook_event_retry" },
            };

            await expectPersistenceFailure(
              persistence.recordEventWithIngressDedupe(event, options),
            );
            await expect(
              persistence.recordEventWithIngressDedupe(event, options),
            ).resolves.toMatchObject({
              deduped: false,
              event: { id: "evt_retry" },
            });
            await expect(persistence.recordEventWithIngressDedupe(event, options)).resolves.toEqual(
              { deduped: true },
            );
          },
          {
            idFactory: {
              eventId: queuedIds(["evt_duplicate", "evt_duplicate", "evt_retry"]),
            },
          },
        );
      });

      it("writes dedupe, event, and observation atomically", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const result = await persistence.recordEventAndProviderObservationWithIngressDedupe({
            event: providerHookEvent("hook_atomic"),
            eventOptions: { source: "hook", createdAt: now },
            observation: healthObservation("healthy"),
            dedupe: { kind: "hook", id: "hook_atomic" },
          });

          expect(result).toMatchObject({
            deduped: false,
            event: { id: "contract_evt_1", source: "hook" },
            observation: {
              id: "contract_obs_1",
              entityKind: "provider_health",
              entityKey: "fake-harness",
            },
          });
          await expect(
            persistence.recordEventAndProviderObservationWithIngressDedupe({
              event: providerHookEvent("hook_atomic"),
              eventOptions: { source: "hook", createdAt: now },
              observation: healthObservation("healthy"),
              dedupe: { kind: "hook", id: "hook_atomic" },
            }),
          ).resolves.toEqual({ deduped: true });
          await expect(persistence.listEvents()).resolves.toHaveLength(1);
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now }),
          ).resolves.toHaveLength(1);
        });
      });

      it("rolls back a partially staged write, consumes generated IDs, and permits retry", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const invalidObservation = {
            ...healthObservation("healthy"),
            payload: { status: "healthy" },
          } as unknown as RecordProviderObservationInput;
          await expectPersistenceFailure(
            persistence.recordEventAndProviderObservationWithIngressDedupe({
              event: providerHookEvent("hook_retry"),
              eventOptions: { source: "hook", createdAt: now },
              observation: invalidObservation,
              dedupe: { kind: "hook", id: "hook_retry" },
            }),
          );
          await expect(persistence.listEvents()).resolves.toEqual([]);
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now }),
          ).resolves.toEqual([]);

          const retried = await persistence.recordEventAndProviderObservationWithIngressDedupe({
            event: providerHookEvent("hook_retry"),
            eventOptions: { source: "hook", createdAt: now },
            observation: healthObservation("healthy"),
            dedupe: { kind: "hook", id: "hook_retry" },
          });
          expect(retried).toMatchObject({
            deduped: false,
            event: { id: "contract_evt_2" },
            observation: { id: "contract_obs_2" },
          });
          await expect(
            persistence.recordEventAndProviderObservationWithIngressDedupe({
              event: providerHookEvent("hook_retry"),
              eventOptions: { source: "hook", createdAt: now },
              observation: healthObservation("healthy"),
              dedupe: { kind: "hook", id: "hook_retry" },
            }),
          ).resolves.toEqual({ deduped: true });
        });
      });

      it("atomically records every downstream observation before claiming processing complete", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const observations = [
            healthObservation("healthy"),
            { ...healthObservation("degraded"), entityKey: "fake-harness-secondary" },
          ];
          const first = await persistence.recordProviderObservationsWithIngressDedupe({
            observations,
            dedupe: { kind: "hook_processing", id: "hook_batch" },
            createdAt: now,
          });
          const duplicate = await persistence.recordProviderObservationsWithIngressDedupe({
            observations,
            dedupe: { kind: "hook_processing", id: "hook_batch" },
            createdAt: now,
          });

          expect(first).toMatchObject({
            deduped: false,
            observations: [{ id: "contract_obs_1" }, { id: "contract_obs_2" }],
          });
          expect(duplicate).toEqual({ deduped: true });
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now }),
          ).resolves.toHaveLength(2);
        });
      });

      it("does not apply readiness derived from a duplicate hook normalization", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const dedupe = { kind: "hook_processing" as const, id: "hook_context_retry" };
          const first = await persistence.recordProviderObservationsWithIngressDedupe({
            observations: [healthObservation("healthy")],
            turnReadiness: [
              {
                action: "upsert",
                value: {
                  sessionId: "ses_original",
                  projectId: "web",
                  worktreeId: "wt_original",
                  token: "hook_context_retry",
                  completedAt: earlier,
                  updatedAt: now,
                },
              },
            ],
            dedupe,
            createdAt: now,
          });
          const duplicate = await persistence.recordProviderObservationsWithIngressDedupe({
            observations: [
              { ...healthObservation("degraded"), entityKey: "fresh-context-observation" },
            ],
            turnReadiness: [
              {
                action: "upsert",
                value: {
                  sessionId: "ses_fresh_context",
                  projectId: "web",
                  worktreeId: "wt_fresh_context",
                  token: "hook_context_retry",
                  completedAt: later,
                  updatedAt: latest,
                },
              },
            ],
            dedupe,
            createdAt: later,
          });

          expect(first).toMatchObject({ deduped: false });
          expect(duplicate).toEqual({ deduped: true });
          await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([
            expect.objectContaining({
              sessionId: "ses_original",
              worktreeId: "wt_original",
              token: "hook_context_retry",
            }),
          ]);
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now: latest }),
          ).resolves.toEqual([expect.objectContaining({ entityKey: "fake-harness" })]);
        });
      });

      it("rolls back a downstream processing claim when any observation is invalid", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const invalid = {
            ...healthObservation("degraded"),
            payload: { status: "degraded" },
          } as unknown as RecordProviderObservationInput;
          const dedupe = { kind: "hook_processing" as const, id: "hook_batch_retry" };

          await expectPersistenceFailure(
            persistence.recordProviderObservationsWithIngressDedupe({
              observations: [healthObservation("healthy"), invalid],
              dedupe,
              createdAt: now,
            }),
          );
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now }),
          ).resolves.toEqual([]);
          await expect(
            persistence.recordProviderObservationsWithIngressDedupe({
              observations: [healthObservation("healthy")],
              dedupe,
              createdAt: now,
            }),
          ).resolves.toMatchObject({ deduped: false, observations: [{ id: "contract_obs_3" }] });
        });
      });
    });

    describe("ObservationStore", () => {
      it("round-trips all five observation discriminants through strict payload schemas", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const worktree = createFakeWorktree({
            id: "wt_observation",
            projectId: "web",
            now,
            providerData: { opaque: "worktree-data" },
          });
          const terminal = createFakeTerminalTarget({
            id: "term_observation",
            projectId: "web",
            worktreeId: worktree.id,
            now,
            providerData: { socketPath: "/tmp/private.sock" },
          });
          const run = createFakeHarnessRun({
            id: "run_observation",
            projectId: "web",
            worktreeId: worktree.id,
            now,
          });
          const inputs: RecordProviderObservationInput[] = [
            {
              provider: worktree.provider,
              providerType: "worktree",
              entityKind: "worktree",
              entityKey: worktree.id,
              payload: worktree,
              observedAt: now,
            },
            {
              provider: terminal.provider,
              providerType: "terminal",
              entityKind: "terminal_target",
              entityKey: terminal.id,
              payload: terminal,
              observedAt: now,
            },
            {
              provider: run.provider,
              providerType: "harness",
              entityKind: "harness_run",
              entityKey: run.id,
              payload: run,
              observedAt: now,
            },
            {
              provider: "fake-harness",
              providerType: "harness",
              entityKind: "harness_event",
              entityKey: "report_observation",
              payload: {
                provider: "fake-harness",
                reportId: "report_observation",
                eventType: "turn.completed",
                worktreeId: worktree.id,
                observedAt: now,
              },
              observedAt: now,
            },
            healthObservation("healthy"),
          ];

          for (const input of inputs) {
            await persistence.recordProviderObservation(input);
          }

          const observations = await persistence.listProviderObservations({
            includeExpired: true,
            now,
          });
          expect(observations.map((observation) => observation.entityKind)).toEqual([
            "worktree",
            "terminal_target",
            "harness_run",
            "harness_event",
            "provider_health",
          ]);
          expect(observations[0]).toMatchObject({ payload: worktree, expired: false });
          expect(observations[1]?.entityKind).toBe("terminal_target");
          if (observations[1]?.entityKind === "terminal_target") {
            expect(observations[1].payload).not.toHaveProperty("providerData");
          }
          expect(observations[4]).toMatchObject({
            payload: { providerId: "fake-harness", status: "healthy" },
          });
        });
      });

      it("supports scalar, array, and empty discriminant filters", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const worktree = createFakeWorktree({ id: "wt_filter", projectId: "web", now });
          await persistence.recordProviderObservation({
            provider: worktree.provider,
            providerType: "worktree",
            entityKind: "worktree",
            entityKey: worktree.id,
            payload: worktree,
            observedAt: now,
          });
          await persistence.recordProviderObservation(healthObservation("healthy"));

          await expect(
            persistence.listProviderObservations({ entityKind: "worktree", now }),
          ).resolves.toEqual([expect.objectContaining({ entityKind: "worktree" })]);
          expect(
            (
              await persistence.listProviderObservations({
                entityKind: ["provider_health", "worktree"],
                now,
              })
            ).map((observation) => observation.entityKind),
          ).toEqual(["worktree", "provider_health"]);
          await expect(
            persistence.listProviderObservations({ entityKind: [], now }),
          ).resolves.toEqual([]);
        });
      });

      it("selects the latest observation by timestamp and then generated ID", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const first = createFakeWorktree({
            id: "wt_latest",
            projectId: "web",
            branch: "first",
            now: earlier,
          });
          const second = createFakeWorktree({
            id: "wt_latest",
            projectId: "web",
            branch: "second",
            now,
          });
          const tieWinner = createFakeWorktree({
            id: "wt_latest",
            projectId: "web",
            branch: "tie-winner",
            now,
          });
          const other = createFakeWorktree({
            id: "wt_other",
            projectId: "web",
            branch: "other",
            now: later,
          });

          for (const worktree of [first, second, tieWinner, other]) {
            await persistence.recordProviderObservation({
              provider: worktree.provider,
              providerType: "worktree",
              entityKind: "worktree",
              entityKey: worktree.id,
              payload: worktree,
              observedAt: worktree.observedAt,
            });
          }

          const latestOnly = await persistence.listProviderObservations({
            entityKind: "worktree",
            latestOnly: true,
            includeExpired: true,
            now,
          });
          expect(latestOnly.map((observation) => observation.id)).toEqual([
            "contract_obs_3",
            "contract_obs_4",
          ]);
          expect(latestOnly[0]?.entityKind).toBe("worktree");
          if (latestOnly[0]?.entityKind === "worktree") {
            expect(latestOnly[0].payload.branch).toBe("tie-winner");
          }
        });
      });

      it("returns only observations attached to current worktree and terminal entities", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const worktree = createFakeWorktree({ id: "wt_current", projectId: "web", now });
          const terminal = createFakeTerminalTarget({
            id: "term_current",
            projectId: "web",
            worktreeId: worktree.id,
            now,
          });
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [worktree],
            terminalTargets: [terminal],
            harnessRuns: [],
            observedAt: now,
          });
          await persistence.recordProviderObservation({
            provider: worktree.provider,
            providerType: "worktree",
            entityKind: "worktree",
            entityKey: worktree.id,
            payload: { ...worktree, branch: "newer", observedAt: later },
            observedAt: later,
          });
          await persistence.recordProviderObservation({
            provider: terminal.provider,
            providerType: "terminal",
            entityKind: "terminal_target",
            entityKey: terminal.id,
            payload: { ...terminal, state: "detached", observedAt: later },
            observedAt: later,
          });
          const historyOnly = createFakeWorktree({
            id: "wt_history_only",
            projectId: "web",
            now: latest,
          });
          await persistence.recordProviderObservation({
            provider: historyOnly.provider,
            providerType: "worktree",
            entityKind: "worktree",
            entityKey: historyOnly.id,
            payload: historyOnly,
            observedAt: latest,
          });

          const current = await persistence.listCurrentProviderEntityObservations({ now: latest });
          expect(current.map((observation) => observation.id)).toEqual([
            "contract_obs_3",
            "contract_obs_4",
          ]);
          expect(current.map((observation) => observation.entityKey)).toEqual([
            "wt_current",
            "term_current",
          ]);
          await expect(
            persistence.listCurrentProviderEntityObservations({
              entityKind: "worktree",
              now: latest,
            }),
          ).resolves.toEqual([expect.objectContaining({ id: "contract_obs_3" })]);
          await expect(
            persistence.listCurrentProviderEntityObservations({ entityKind: [], now: latest }),
          ).resolves.toEqual([]);
        });
      });

      it("uses an inclusive expiry boundary and prunes only finite expired rows", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const expiries = [later, now, earlier, undefined] as const;
          for (const [index, expiresAt] of expiries.entries()) {
            const worktree = createFakeWorktree({
              id: `wt_expiry_${index}`,
              projectId: "web",
              now: earlier,
            });
            await persistence.recordProviderObservation({
              provider: worktree.provider,
              providerType: "worktree",
              entityKind: "worktree",
              entityKey: worktree.id,
              payload: worktree,
              observedAt: earlier,
              expiresAt,
            });
          }

          expect(
            (await persistence.listProviderObservations({ now })).map(
              (observation) => observation.entityKey,
            ),
          ).toEqual(["wt_expiry_0", "wt_expiry_3"]);
          const all = await persistence.listProviderObservations({ includeExpired: true, now });
          expect(all.map((observation) => observation.expired)).toEqual([false, true, true, false]);
          expect(all[3]).not.toHaveProperty("expiresAt");
          await expect(persistence.pruneExpiredProviderObservations(now)).resolves.toBe(2);
          expect(
            (await persistence.listProviderObservations({ includeExpired: true, now })).map(
              (observation) => observation.entityKey,
            ),
          ).toEqual(["wt_expiry_0", "wt_expiry_3"]);
        });
      });

      it("normalizes provider payloads through the durable JSON representation", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const nonJsonData = createFakeWorktree({
            id: "wt_json_normalized",
            projectId: "web",
            now,
            providerData: {
              checkedAt: new Date(now),
              lookup: new Map([["branch", "main"]]),
            },
          });
          const normalized = await persistence.recordProviderObservation({
            provider: nonJsonData.provider,
            providerType: "worktree",
            entityKind: "worktree",
            entityKey: nonJsonData.id,
            payload: nonJsonData,
            observedAt: now,
          });
          expect(normalized.entityKind).toBe("worktree");
          if (normalized.entityKind === "worktree") {
            expect(normalized.payload.providerData).toEqual({ checkedAt: now, lookup: {} });
          }

          const explicitUndefined = {
            ...createFakeWorktree({ id: "wt_optional_json", projectId: "web", now }),
            providerData: undefined,
          };
          const withoutUndefined = await persistence.recordProviderObservation({
            provider: explicitUndefined.provider,
            providerType: "worktree",
            entityKind: "worktree",
            entityKey: explicitUndefined.id,
            payload: explicitUndefined,
            observedAt: now,
          });
          expect(withoutUndefined.entityKind).toBe("worktree");
          if (withoutUndefined.entityKind === "worktree") {
            expect(withoutUndefined.payload).not.toHaveProperty("providerData");
          }

          const unsupported = createFakeWorktree({
            id: "wt_non_json",
            projectId: "web",
            now,
            providerData: { count: 1n },
          });
          await expectPersistenceFailure(
            persistence.recordProviderObservation({
              provider: unsupported.provider,
              providerType: "worktree",
              entityKind: "worktree",
              entityKey: unsupported.id,
              payload: unsupported,
              observedAt: now,
            }),
          );
          await expect(
            persistence.recordProviderObservation(healthObservation("healthy")),
          ).resolves.toMatchObject({ id: "contract_obs_4" });
        });
      });

      it("strictly validates discriminants and payloads while consuming minted observation IDs", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const invalid = {
            ...healthObservation("healthy"),
            payload: {
              providerId: "fake-harness",
              status: "healthy",
              lastCheckedAt: now,
            },
          } as unknown as RecordProviderObservationInput;
          await expectPersistenceFailure(persistence.recordProviderObservation(invalid));

          const unknownKind = {
            ...healthObservation("healthy"),
            entityKind: "retired_kind",
          } as unknown as RecordProviderObservationInput;
          await expectPersistenceFailure(persistence.recordProviderObservation(unknownKind));

          const mismatchedKind = {
            ...healthObservation("healthy"),
            entityKind: "worktree",
          } as unknown as RecordProviderObservationInput;
          await expectPersistenceFailure(persistence.recordProviderObservation(mismatchedKind));

          await expect(
            persistence.recordProviderObservation(healthObservation("healthy")),
          ).resolves.toMatchObject({ id: "contract_obs_4" });
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now }),
          ).resolves.toHaveLength(1);
        });
      });

      it("coalesces top-level volatile changes but not nested payload changes", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const firstWorktree = createFakeWorktree({
            id: "wt_coalesce",
            projectId: "web",
            now,
            providerData: { nested: { observedAt: earlier } },
          });
          const firstTerminal = createFakeTerminalTarget({
            id: "term_coalesce",
            projectId: "web",
            worktreeId: firstWorktree.id,
            now,
          });
          const firstRun = createFakeHarnessRun({
            id: "run_coalesce",
            projectId: "web",
            worktreeId: firstWorktree.id,
            now,
          });
          const firstHealth = {
            providerId: "fake-harness",
            providerType: "harness" as const,
            status: "healthy" as const,
            lastCheckedAt: now,
            latencyMs: 5,
          };
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [firstWorktree],
            terminalTargets: [firstTerminal],
            harnessRuns: [firstRun],
            providerHealth: { "fake-harness": firstHealth },
            observedAt: now,
            expiresAt: later,
          });
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [{ ...firstWorktree, observedAt: later }],
            terminalTargets: [{ ...firstTerminal, observedAt: later }],
            harnessRuns: [{ ...firstRun, observedAt: later }],
            providerHealth: {
              "fake-harness": { ...firstHealth, lastCheckedAt: later, latencyMs: 99 },
            },
            observedAt: later,
            expiresAt: latest,
          });

          let observations = await persistence.listProviderObservations({
            includeExpired: true,
            now: later,
          });
          expect(observations.map((observation) => observation.id)).toEqual([
            "contract_obs_1",
            "contract_obs_2",
            "contract_obs_3",
            "contract_obs_4",
          ]);
          expect(observations.map((observation) => observation.observedAt)).toEqual([
            later,
            later,
            later,
            later,
          ]);
          expect(observations.map((observation) => observation.expiresAt)).toEqual([
            latest,
            latest,
            latest,
            latest,
          ]);

          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [
              {
                ...firstWorktree,
                observedAt: latest,
                providerData: { nested: { observedAt: latest } },
              },
            ],
            terminalTargets: [{ ...firstTerminal, observedAt: latest }],
            harnessRuns: [{ ...firstRun, observedAt: latest }],
            observedAt: latest,
          });
          observations = await persistence.listProviderObservations({
            entityKind: "worktree",
            includeExpired: true,
            now: latest,
          });
          expect(observations.map((observation) => observation.id)).toEqual([
            "contract_obs_1",
            "contract_obs_9",
          ]);
        });
      });
    });

    describe("ReconcileStore", () => {
      it("atomically persists the complete correlated graph", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const worktree = createFakeWorktree({
            id: "wt_graph",
            projectId: "web",
            branch: "feature/graph",
            now,
          });
          const terminal = createFakeTerminalTarget({
            id: "term_graph",
            projectId: "web",
            worktreeId: worktree.id,
            sessionId: "ses_graph",
            harnessRunId: "run_graph",
            now,
          });
          const run = createFakeHarnessRun({
            id: "run_graph",
            projectId: "web",
            worktreeId: worktree.id,
            sessionId: "ses_graph",
            state: "working",
            now: later,
          });
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [worktree],
            terminalTargets: [terminal],
            harnessRuns: [run],
            providerHealth: {
              "fake-harness": {
                providerId: "fake-harness",
                providerType: "harness",
                status: "healthy",
                lastCheckedAt: now,
              },
            },
            observedAt: now,
            expiresAt: latest,
          });

          expect(
            (await persistence.listProviderObservations({ includeExpired: true, now })).map(
              (observation) => observation.entityKind,
            ),
          ).toEqual(["worktree", "terminal_target", "provider_health", "harness_run"]);
          await expect(persistence.listSessions()).resolves.toEqual([
            {
              id: "ses_graph",
              projectId: "web",
              worktreeId: "wt_graph",
              title: "feature/graph",
              harness: "fake-harness",
              terminalProvider: "fake-terminal",
              state: "working",
              createdAt: now,
              lastSeenAt: later,
            },
          ]);
          await expect(
            persistence.findRememberedHarnessProviderForWorktree({
              projectId: "web",
              worktreeId: worktree.id,
              worktreePath: worktree.path,
            }),
          ).resolves.toBe("fake-harness");
        });
      });

      it("derives each observation expiry from the configured retention", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const worktree = createFakeWorktree({ id: "wt_retention", projectId: "web", now });
          const terminal = createFakeTerminalTarget({
            id: "term_retention",
            projectId: "web",
            worktreeId: worktree.id,
            now,
          });
          const run = createFakeHarnessRun({
            id: "run_retention",
            projectId: "web",
            worktreeId: worktree.id,
            now,
          });
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [worktree],
            terminalTargets: [terminal],
            harnessRuns: [run],
            providerHealth: {
              "fake-harness": {
                providerId: "fake-harness",
                providerType: "harness",
                status: "healthy",
                lastCheckedAt: now,
              },
            },
            observedAt: now,
            providerObservationRetentionDays: 2,
          });

          const observations = await persistence.listProviderObservations({
            includeExpired: true,
            now,
          });
          expect(observations.map((observation) => observation.entityKind)).toEqual([
            "worktree",
            "terminal_target",
            "harness_run",
            "provider_health",
          ]);
          expect(observations).toHaveLength(4);
          expect(
            observations.every(
              (observation) => observation.expiresAt === "2026-05-22T12:00:00.000Z",
            ),
          ).toBe(true);
        });
      });

      it("rolls back earlier staged arrays when a later graph input is invalid", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const worktree = createFakeWorktree({ id: "wt_rollback", projectId: "web", now });
          const invalidTerminal = {
            ...createFakeTerminalTarget({
              id: "term_invalid",
              projectId: "web",
              worktreeId: worktree.id,
              now,
            }),
            state: "archived",
          } as unknown as ReturnType<typeof createFakeTerminalTarget>;

          await expectPersistenceFailure(
            persistence.persistReconcileResult({
              projects: [project],
              worktrees: [worktree],
              terminalTargets: [invalidTerminal],
              harnessRuns: [],
              observedAt: now,
            }),
          );
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now }),
          ).resolves.toEqual([]);
          await expect(persistence.listSessions()).resolves.toEqual([]);

          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [worktree],
            terminalTargets: [],
            harnessRuns: [],
            observedAt: now,
          });
          await expect(
            persistence.listProviderObservations({ includeExpired: true, now }),
          ).resolves.toEqual([expect.objectContaining({ id: "contract_obs_2" })]);
        });
      });
    });

    describe("SessionStore", () => {
      it("orders sessions by ID and preserves seeded and renamed titles", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          await persistence.seedSessionTitle({
            sessionId: "ses_z",
            projectId: "web",
            worktreeId: "wt_z",
            title: "z title",
            createdAt: now,
            lastSeenAt: now,
          });
          await persistence.seedSessionTitle({
            sessionId: "ses_a",
            projectId: "web",
            worktreeId: "wt_a",
            title: "a title",
            createdAt: now,
            lastSeenAt: now,
          });
          expect((await persistence.listSessions()).map((session) => session.id)).toEqual([
            "ses_a",
            "ses_z",
          ]);

          await persistence.seedSessionTitle({
            sessionId: "ses_seeded",
            projectId: "web",
            worktreeId: "wt_seeded",
            title: "original title",
            createdAt: earlier,
            lastSeenAt: earlier,
          });
          const reseeded = await persistence.seedSessionTitle({
            sessionId: "ses_seeded",
            projectId: "web",
            worktreeId: "wt_seeded",
            title: "ignored replacement",
            createdAt: later,
            lastSeenAt: later,
          });
          expect(reseeded).toMatchObject({
            title: "original title",
            createdAt: earlier,
            lastSeenAt: later,
          });

          const worktree = createFakeWorktree({
            id: "wt_seeded",
            projectId: "web",
            branch: "provider branch",
            now: later,
          });
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [worktree],
            terminalTargets: [
              createFakeTerminalTarget({
                id: "term_seeded",
                projectId: "web",
                worktreeId: worktree.id,
                sessionId: "ses_seeded",
                now: later,
              }),
            ],
            harnessRuns: [],
            observedAt: later,
          });
          expect(
            (await persistence.listSessions()).find((session) => session.id === "ses_seeded"),
          ).toMatchObject({ title: "original title" });

          await expect(
            persistence.renameSession({ sessionId: "ses_seeded", title: "user title" }),
          ).resolves.toMatchObject({ title: "user title" });
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [{ ...worktree, branch: "renamed provider branch", observedAt: latest }],
            terminalTargets: [
              createFakeTerminalTarget({
                id: "term_seeded",
                projectId: "web",
                worktreeId: worktree.id,
                sessionId: "ses_seeded",
                now: latest,
              }),
            ],
            harnessRuns: [],
            observedAt: latest,
          });
          expect(
            (await persistence.listSessions()).find((session) => session.id === "ses_seeded"),
          ).toMatchObject({ title: "user title" });
          await expect(
            persistence.renameSession({ sessionId: "ses_missing", title: "missing" }),
          ).resolves.toBeUndefined();

          await persistence.seedSessionTitle({
            sessionId: "ses_delete",
            projectId: "web",
            worktreeId: "wt_delete",
            title: "delete me",
            createdAt: now,
            lastSeenAt: now,
          });
          await expect(persistence.deleteSessionTitleSeed("ses_delete")).resolves.toBe(1);
          await expect(persistence.deleteSessionTitleSeed("ses_delete")).resolves.toBe(0);
        });
      });

      it("uses direct worktree identity before normalized path continuity and project scope", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          await persistHarnessSession(persistence, {
            project,
            worktreeId: "wt_direct",
            sessionId: "ses_direct",
            provider: "pi",
            path: "/var/tmp/station/web",
            observedAt: earlier,
          });
          await persistHarnessSession(persistence, {
            project,
            worktreeId: "wt_old",
            sessionId: "ses_old",
            provider: "codex",
            path: "/private/var/tmp/station/web/",
            observedAt: later,
          });
          await persistHarnessSession(persistence, {
            project: { ...project, id: "other", label: "other", root: "/tmp/station/other" },
            worktreeId: "wt_other_project",
            sessionId: "ses_other_project",
            provider: "claude",
            path: "/var/tmp/station/web",
            observedAt: latest,
          });

          await expect(
            persistence.findRememberedHarnessProviderForWorktree({
              projectId: "web",
              worktreeId: "wt_new",
              worktreePath: "/var/tmp/station/web",
            }),
          ).resolves.toBe("codex");
          await expect(
            persistence.findRememberedHarnessProviderForWorktree({
              projectId: "web",
              worktreeId: "wt_direct",
              worktreePath: "/var/tmp/station/web",
            }),
          ).resolves.toBe("pi");
          await expect(
            persistence.findRememberedHarnessProviderForWorktree({
              projectId: "missing",
              worktreeId: "wt_new",
              worktreePath: "/var/tmp/station/web",
            }),
          ).resolves.toBeUndefined();
        });
      });

      it("breaks remembered-harness ties by last seen, creation time, and session ID", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const path = "/var/tmp/station/tie";
          await persistHarnessSession(persistence, {
            project,
            worktreeId: "wt_tie_a",
            sessionId: "ses_tie_a",
            provider: "provider-a",
            path,
            observedAt: earlier,
          });
          await persistHarnessSession(persistence, {
            project,
            worktreeId: "wt_tie_a",
            sessionId: "ses_tie_a",
            provider: "provider-a",
            path,
            observedAt: latest,
          });
          await persistHarnessSession(persistence, {
            project,
            worktreeId: "wt_tie_b",
            sessionId: "ses_tie_b",
            provider: "provider-b",
            path,
            observedAt: now,
          });
          await persistHarnessSession(persistence, {
            project,
            worktreeId: "wt_tie_b",
            sessionId: "ses_tie_b",
            provider: "provider-b",
            path,
            observedAt: latest,
          });
          await expect(
            persistence.findRememberedHarnessProviderForWorktree({
              projectId: "web",
              worktreeId: "wt_unknown",
              worktreePath: path,
            }),
          ).resolves.toBe("provider-b");

          for (const suffix of ["c", "z"] as const) {
            await persistHarnessSession(persistence, {
              project,
              worktreeId: `wt_tie_${suffix}`,
              sessionId: `ses_tie_${suffix}`,
              provider: `provider-${suffix}`,
              path,
              observedAt: latest,
            });
          }
          await expect(
            persistence.findRememberedHarnessProviderForWorktree({
              projectId: "web",
              worktreeId: "wt_unknown",
              worktreePath: path,
            }),
          ).resolves.toBe("provider-z");
        });
      });

      it("keeps stable recovery identity, merges optional correlation, and filters handles", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const firstInput: SessionRecoveryHandle = {
            id: "report_first",
            provider: "codex",
            projectId: "web",
            worktreeId: "wt_recovery",
            sessionId: "ses_recovery",
            target: { kind: "native-session", id: "native_123" },
            cwd: "/tmp/station/web/recovery",
            terminalTargetId: "term_recovery",
            harnessRunId: "run_recovery",
            observedAt: now,
            lastSeenAt: now,
          };
          const first = await persistence.upsertSessionRecoveryHandle(firstInput);
          const merged = await persistence.upsertSessionRecoveryHandle({
            id: "report_second",
            provider: "codex",
            projectId: "web",
            worktreeId: "wt_recovery",
            target: { kind: "native-session", id: "native_123" },
            observedAt: earlier,
            lastSeenAt: later,
          });

          expect(merged.id).toBe(first.id);
          expect(merged).toEqual({
            id: first.id,
            provider: "codex",
            projectId: "web",
            worktreeId: "wt_recovery",
            sessionId: "ses_recovery",
            target: { kind: "native-session", id: "native_123" },
            cwd: "/tmp/station/web/recovery",
            terminalTargetId: "term_recovery",
            harnessRunId: "run_recovery",
            observedAt: earlier,
            lastSeenAt: later,
          });
          await expect(persistence.getSessionRecoveryHandle(first.id)).resolves.toEqual(merged);
          await expect(
            persistence.getSessionRecoveryHandle("rec_missing"),
          ).resolves.toBeUndefined();

          const other = await persistence.upsertSessionRecoveryHandle({
            id: "report_other",
            provider: "claude",
            projectId: "other",
            worktreeId: "wt_other",
            target: { kind: "session-file", path: "/tmp/claude/session.jsonl" },
            observedAt: latest,
            lastSeenAt: latest,
          });
          expect(other.id).not.toBe(first.id);
          expect(
            (await persistence.listSessionRecoveryHandles()).map((handle) => handle.id),
          ).toEqual([other.id, first.id]);
          await expect(
            persistence.listSessionRecoveryHandles({
              projectId: "web",
              worktreeId: "wt_recovery",
              provider: "codex",
            }),
          ).resolves.toEqual([merged]);
          await expect(
            persistence.listSessionRecoveryHandles({ provider: "missing" }),
          ).resolves.toEqual([]);
          expect(JSON.stringify(await persistence.listSessionRecoveryHandles())).not.toContain(
            "providerData",
          );
        });
      });

      it("keeps the newest readiness per session and deletes by optional token", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const first = await persistence.upsertSessionTurnReadiness({
            sessionId: "ses_ready",
            projectId: "web",
            worktreeId: "wt_ready",
            token: "token_first",
            completedAt: now,
          });
          expect(first).toEqual({
            sessionId: "ses_ready",
            projectId: "web",
            worktreeId: "wt_ready",
            token: "token_first",
            completedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          await persistence.upsertSessionTurnReadiness({
            sessionId: "ses_ready",
            projectId: "web",
            worktreeId: "wt_ready",
            token: "token_older",
            completedAt: earlier,
            createdAt: earlier,
            updatedAt: later,
          });
          await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([first]);

          await persistence.upsertSessionTurnReadiness({
            sessionId: "ses_ready",
            projectId: "web",
            worktreeId: "wt_ready",
            token: "token_newer",
            completedAt: later,
            createdAt: later,
            updatedAt: latest,
          });
          await persistence.upsertSessionTurnReadiness({
            sessionId: "ses_z",
            projectId: "web",
            worktreeId: "wt_z",
            token: "token_z",
            completedAt: later,
          });
          expect(
            (await persistence.listSessionTurnReadiness()).map((item) => item.sessionId),
          ).toEqual(["ses_ready", "ses_z"]);
          expect((await persistence.listSessionTurnReadiness())[0]).toMatchObject({
            token: "token_newer",
            createdAt: now,
            updatedAt: latest,
          });
          await expect(
            persistence.deleteSessionTurnReadiness({
              sessionId: "ses_ready",
              token: "token_first",
            }),
          ).resolves.toBe(0);
          await expect(
            persistence.deleteSessionTurnReadiness({
              sessionId: "ses_ready",
              token: "token_newer",
            }),
          ).resolves.toBe(1);
          await expect(
            persistence.deleteSessionTurnReadiness({ sessionId: "ses_z" }),
          ).resolves.toBe(1);
          await expect(persistence.listSessionTurnReadiness()).resolves.toEqual([]);
        });
      });
    });

    describe("WorktreeMetadataStore", () => {
      it("replaces rows, filters and orders kinds, marks expiry, and preserves stale errors", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const staleError = contractSafeError("METADATA_STALE");
          await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_z",
            kind: "change_summary",
            cacheKey: "first",
            updatedAt: now,
            expiresAt: latest,
            payload: changeSummary(1),
          });
          await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_z",
            kind: "change_summary",
            cacheKey: "second",
            updatedAt: later,
            expiresAt: latest,
            stale: true,
            lastError: staleError,
            payload: { ...changeSummary(2), stale: true },
          });
          await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_a",
            kind: "pull_request",
            updatedAt: now,
            payload: {
              number: 12,
              host: "github",
              baseRef: "main",
              headRef: "feature",
              checkedAt: now,
            },
          });
          await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_b",
            kind: "checks",
            updatedAt: now,
            payload: {
              state: "running",
              total: 2,
              pending: 2,
              source: "github",
              checkedAt: now,
            },
          });
          await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_expired",
            kind: "change_summary",
            updatedAt: earlier,
            expiresAt: now,
            payload: changeSummary(9, earlier),
          });

          await expect(
            persistence.listWorktreeMetadataCurrent({ kind: "change_summary", now }),
          ).resolves.toEqual([
            expect.objectContaining({
              worktreeId: "wt_z",
              cacheKey: "second",
              stale: true,
              lastError: staleError,
              payload: expect.objectContaining({ additions: 2, stale: true }),
            }),
          ]);
          expect(
            (
              await persistence.listWorktreeMetadataCurrent({
                kind: ["pull_request", "checks"],
                now,
              })
            ).map((row) => `${row.worktreeId}:${row.kind}`),
          ).toEqual(["wt_a:pull_request", "wt_b:checks"]);
          await expect(persistence.listWorktreeMetadataCurrent({ kind: [], now })).resolves.toEqual(
            [],
          );

          const all = await persistence.listWorktreeMetadataCurrent({
            includeExpired: true,
            now,
          });
          expect(all.map((row) => `${row.worktreeId}:${row.kind}`)).toEqual([
            "wt_expired:change_summary",
            "wt_a:pull_request",
            "wt_b:checks",
            "wt_z:change_summary",
          ]);
          expect(all[0]).toMatchObject({ expired: true, expiresAt: now });
          expect(all[1]).not.toHaveProperty("expiresAt");
        });
      });

      it("rejects malformed payload and error replacements without losing the current row", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const original = await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_valid",
            kind: "change_summary",
            cacheKey: "original",
            updatedAt: now,
            payload: changeSummary(3),
          });
          await expectPersistenceFailure(
            persistence.upsertWorktreeMetadataCurrent({
              worktreeId: "wt_valid",
              kind: "change_summary",
              cacheKey: "invalid-payload",
              updatedAt: later,
              payload: {
                ...changeSummary(4),
                additions: -1,
              } as never,
            }),
          );
          await expectPersistenceFailure(
            persistence.upsertWorktreeMetadataCurrent({
              worktreeId: "wt_valid",
              kind: "change_summary",
              cacheKey: "invalid-error",
              updatedAt: later,
              payload: changeSummary(5),
              lastError: {
                ...contractSafeError("INVALID_ERROR"),
                unexpected: true,
              } as unknown as SafeError,
            }),
          );
          await expectPersistenceFailure(
            persistence.upsertWorktreeMetadataCurrent({
              worktreeId: "wt_valid",
              kind: "unknown" as "checks",
              updatedAt: later,
              payload: {
                state: "pass",
                source: "github",
                checkedAt: later,
              },
            }),
          );

          await expect(
            persistence.listWorktreeMetadataCurrent({ includeExpired: true, now: later }),
          ).resolves.toEqual([original]);
        });
      });

      it("reports deletion counts for one kind, all kinds, and missing rows", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_delete",
            kind: "change_summary",
            payload: changeSummary(1),
          });
          await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_delete",
            kind: "checks",
            payload: {
              state: "pass",
              source: "github",
              checkedAt: now,
            },
          });
          await expect(
            persistence.deleteWorktreeMetadataCurrent({
              worktreeId: "wt_delete",
              kind: "checks",
            }),
          ).resolves.toBe(1);
          await expect(
            persistence.deleteWorktreeMetadataCurrent({ worktreeId: "wt_delete" }),
          ).resolves.toBe(1);
          await expect(
            persistence.deleteWorktreeMetadataCurrent({ worktreeId: "wt_delete" }),
          ).resolves.toBe(0);
          await expect(
            persistence.listWorktreeMetadataCurrent({ includeExpired: true, now }),
          ).resolves.toEqual([]);
        });
      });
    });

    describe("cross-cutting behavior", () => {
      it("omits absent optional fields from every returned record shape", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const accepted = await persistence.recordCommandAccepted({
            commandId: "cmd_optional",
            command,
          });
          expect(accepted).not.toHaveProperty("startedAt");
          expect(accepted).not.toHaveProperty("finishedAt");
          expect(accepted).not.toHaveProperty("traceId");
          expect(accepted).not.toHaveProperty("spanId");
          expect(accepted).not.toHaveProperty("error");
          expect(accepted).not.toHaveProperty("diagnostics");

          const event = await persistence.recordEvent({
            type: "project.updated",
            projectId: "web",
          });
          expect(event.createdAt).toBe(now);
          expect(event).not.toHaveProperty("commandId");
          expect(event).not.toHaveProperty("traceId");
          expect(event).not.toHaveProperty("spanId");

          const observation = await persistence.recordProviderObservation({
            ...healthObservation("healthy"),
            expiresAt: undefined,
          });
          expect(observation).not.toHaveProperty("expiresAt");

          const session = await persistence.seedSessionTitle({
            sessionId: "ses_optional",
            projectId: "web",
            worktreeId: "wt_optional",
            title: "optional",
            createdAt: now,
            lastSeenAt: now,
          });
          expect(session).not.toHaveProperty("harness");
          expect(session).not.toHaveProperty("terminalProvider");
          expect(session).not.toHaveProperty("state");
          expect(session).not.toHaveProperty("endedAt");

          const metadata = await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_optional",
            kind: "change_summary",
            expiresAt: undefined,
            payload: changeSummary(0),
          });
          expect(metadata).not.toHaveProperty("cacheKey");
          expect(metadata).not.toHaveProperty("expiresAt");
          expect(metadata).not.toHaveProperty("lastError");

          const handle = await persistence.upsertSessionRecoveryHandle({
            id: "report_optional",
            provider: "codex",
            projectId: "web",
            worktreeId: "wt_optional",
            target: { kind: "native-session", id: "native_optional" },
            observedAt: now,
            lastSeenAt: now,
          });
          expect(handle).not.toHaveProperty("sessionId");
          expect(handle).not.toHaveProperty("cwd");
          expect(handle).not.toHaveProperty("terminalTargetId");
          expect(handle).not.toHaveProperty("harnessRunId");
        });
      });

      it("detaches mutable inputs and every returned value from stored state", async () => {
        await withPersistence(createFixture, async ({ persistence }) => {
          const commandInput: StationCommand = {
            type: "observer.reconcile",
            payload: { reason: "original command" },
          };
          const accepted = await persistence.recordCommandAccepted({
            commandId: "cmd_detached",
            command: commandInput,
            createdAt: now,
          });
          commandInput.payload.reason = "mutated input";
          if (accepted.command.type === "observer.reconcile") {
            accepted.command.payload.reason = "mutated output";
          }
          const rereadCommand = await persistence.getCommand("cmd_detached");
          expect(rereadCommand).toMatchObject({
            command: { payload: { reason: "original command" } },
          });
          if (rereadCommand?.command.type === "observer.reconcile") {
            rereadCommand.command.payload.reason = "mutated read";
          }
          await expect(persistence.getCommand("cmd_detached")).resolves.toMatchObject({
            command: { payload: { reason: "original command" } },
          });

          const eventInput = providerHookEvent("hook_detached");
          const persistedEvent = await persistence.recordEvent(eventInput, { createdAt: now });
          if (eventInput.type === "providerHook.ingested") eventInput.hookId = "mutated input";
          if (persistedEvent.event.type === "providerHook.ingested") {
            persistedEvent.event.hookId = "mutated output";
          }
          const rereadEvents = await persistence.listEvents();
          expect(rereadEvents).toEqual([
            expect.objectContaining({
              event: expect.objectContaining({ hookId: "hook_detached" }),
            }),
          ]);
          if (rereadEvents[0]?.event.type === "providerHook.ingested") {
            rereadEvents[0].event.hookId = "mutated read";
          }
          await expect(persistence.listEvents()).resolves.toEqual([
            expect.objectContaining({
              event: expect.objectContaining({ hookId: "hook_detached" }),
            }),
          ]);

          const worktree = createFakeWorktree({
            id: "wt_detached",
            projectId: "web",
            branch: "original branch",
            now,
          });
          const persistedObservation = await persistence.recordProviderObservation({
            provider: worktree.provider,
            providerType: "worktree",
            entityKind: "worktree",
            entityKey: worktree.id,
            payload: worktree,
            observedAt: now,
          });
          worktree.branch = "mutated input";
          if (persistedObservation.entityKind === "worktree") {
            persistedObservation.payload.branch = "mutated output";
          }
          const rereadObservation = (
            await persistence.listProviderObservations({ entityKind: "worktree", now })
          )[0];
          expect(rereadObservation?.entityKind).toBe("worktree");
          if (rereadObservation?.entityKind === "worktree") {
            expect(rereadObservation.payload.branch).toBe("original branch");
            rereadObservation.payload.branch = "mutated list output";
          }
          const detachedObservation = (
            await persistence.listProviderObservations({ entityKind: "worktree", now })
          )[0];
          expect(detachedObservation?.entityKind).toBe("worktree");
          if (detachedObservation?.entityKind === "worktree") {
            expect(detachedObservation.payload.branch).toBe("original branch");
          }

          const reconcileWorktree = createFakeWorktree({
            id: "wt_reconcile_detached",
            projectId: "web",
            branch: "reconcile original",
            now,
          });
          await persistence.persistReconcileResult({
            projects: [project],
            worktrees: [reconcileWorktree],
            terminalTargets: [],
            harnessRuns: [],
            observedAt: now,
          });
          reconcileWorktree.branch = "mutated reconcile input";
          const reconciledObservation = (
            await persistence.listProviderObservations({ entityKind: "worktree", now })
          ).find((observation) => observation.entityKey === reconcileWorktree.id);
          expect(reconciledObservation?.entityKind).toBe("worktree");
          if (reconciledObservation?.entityKind === "worktree") {
            expect(reconciledObservation.payload.branch).toBe("reconcile original");
          }

          const metadataPayload = changeSummary(4);
          const persistedMetadata = await persistence.upsertWorktreeMetadataCurrent({
            worktreeId: "wt_detached",
            kind: "change_summary",
            payload: metadataPayload,
          });
          metadataPayload.additions = 40;
          persistedMetadata.payload.additions = 400;
          await expect(
            persistence.listWorktreeMetadataCurrent({ kind: "change_summary", now }),
          ).resolves.toEqual([
            expect.objectContaining({ payload: expect.objectContaining({ additions: 4 }) }),
          ]);

          const recoveryInput: SessionRecoveryHandle = {
            id: "report_detached",
            provider: "codex",
            projectId: "web",
            worktreeId: "wt_detached",
            target: { kind: "native-session", id: "native_detached" },
            observedAt: now,
            lastSeenAt: now,
          };
          const persistedHandle = await persistence.upsertSessionRecoveryHandle(recoveryInput);
          recoveryInput.worktreeId = "mutated_input";
          persistedHandle.worktreeId = "mutated_output";
          await expect(
            persistence.getSessionRecoveryHandle(persistedHandle.id),
          ).resolves.toMatchObject({
            worktreeId: "wt_detached",
          });
        });
      });
    });
  });
}

async function withPersistence(
  createFixture: ObserverPersistenceContractFactory,
  run: (context: ContractContext) => Promise<void>,
  options: ContractOptions = {},
): Promise<void> {
  let currentTime = options.now ?? now;
  const idFactory = {
    ...sequentialIds(options.idPrefix ?? "contract"),
    ...options.idFactory,
  };
  const fixture = await createFixture({
    clock: { now: () => new Date(currentTime) },
    idFactory,
  });
  try {
    await run({
      persistence: fixture.persistence,
      setNow: (value) => {
        currentTime = value;
      },
    });
  } finally {
    await fixture.close?.();
  }
}

function sequentialIds(prefix: string): ObserverIdFactory {
  let commandId = 0;
  let eventId = 0;
  let errorId = 0;
  let observationId = 0;
  return {
    commandId: () => `${prefix}_cmd_${++commandId}`,
    eventId: () => `${prefix}_evt_${++eventId}`,
    errorId: () => `${prefix}_err_${++errorId}`,
    observationId: () => `${prefix}_obs_${++observationId}`,
  };
}

function queuedIds(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `unexpected_id_${index}`;
}

async function expectPersistenceFailure(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toThrow("PERSISTENCE_TRANSACTION_FAILED");
}

function contractSafeError(code: string): SafeError {
  return {
    tag: "ContractFailure",
    code,
    message: "The persistence contract operation failed.",
  };
}

function contractEnvelope(input: {
  id: string;
  commandId: string;
  createdAt: string;
  diagnostics?: ErrorEnvelope["diagnostics"];
}): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    id: input.id,
    tag: "ContractFailure",
    code: "COMMAND_FAILED",
    message: "Internal persistence contract detail.",
    severity: "error",
    commandId: input.commandId,
    redacted: true,
    createdAt: input.createdAt,
  };
  if (input.diagnostics !== undefined) {
    envelope.diagnostics = input.diagnostics;
  }
  return envelope;
}

function providerHookEvent(hookId: string): StationEvent {
  return {
    type: "providerHook.ingested",
    at: now,
    hookId,
    provider: "fake-harness",
    event: "run.updated",
  };
}

function healthObservation(status: "healthy" | "degraded"): RecordProviderObservationInput {
  return {
    provider: "fake-harness",
    providerType: "harness",
    entityKind: "provider_health",
    entityKey: "fake-harness",
    payload: {
      providerId: "fake-harness",
      providerType: "harness",
      status,
      lastCheckedAt: now,
    },
    observedAt: now,
  };
}

async function persistHarnessSession(
  persistence: ObserverPersistenceBundle,
  input: {
    project: ProviderProjectConfig;
    worktreeId: string;
    sessionId: string;
    provider: string;
    path: string;
    observedAt: string;
  },
): Promise<void> {
  const worktree = createFakeWorktree({
    id: input.worktreeId,
    projectId: input.project.id,
    path: input.path,
    now: input.observedAt,
  });
  await persistence.persistReconcileResult({
    projects: [input.project],
    worktrees: [worktree],
    terminalTargets: [],
    harnessRuns: [
      createFakeHarnessRun({
        id: `run_${input.sessionId}`,
        provider: input.provider,
        projectId: input.project.id,
        worktreeId: input.worktreeId,
        sessionId: input.sessionId,
        now: input.observedAt,
      }),
    ],
    observedAt: input.observedAt,
  });
}

function changeSummary(additions: number, checkedAt = now) {
  return {
    kind: "branch_diff" as const,
    additions,
    deletions: 1,
    source: "local_git",
    checkedAt,
  };
}
