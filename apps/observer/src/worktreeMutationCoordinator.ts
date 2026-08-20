import { randomUUID } from "node:crypto";
import type { SafeError } from "@station/contracts";

const DEFAULT_RESERVATION_TIMEOUT_MS = 60_000;

export type WorktreeMutationReservation<T> = {
  id: string;
  projectId: string;
  worktreeId: string;
  value: T;
};

export type WorktreeMutationCoordinator = {
  run<T>(projectId: string, worktreeId: string, mutation: () => Promise<T>): Promise<T>;
  /** Refuse instead of queueing behind an external reservation that its command cannot consume. */
  runUnreserved<T>(projectId: string, worktreeId: string, mutation: () => Promise<T>): Promise<T>;
  /** Hold one worktree's mutation slot across an external, bounded preparation step. */
  reserve<T>(
    projectId: string,
    worktreeId: string,
    prepare: () => Promise<T>,
  ): Promise<WorktreeMutationReservation<T>>;
  /** Consume only the exact active reservation and release its slot after mutation settles. */
  consume<T, R>(
    reservationId: string,
    projectId: string,
    worktreeId: string,
    mutation: (value: T) => Promise<R>,
  ): Promise<R>;
  cancel(reservationId: string): boolean;
};

export type CreateWorktreeMutationCoordinatorOptions = {
  reservationTimeoutMs?: number;
  reservationId?: () => string;
};

type ActiveReservation = {
  id: string;
  projectId: string;
  worktreeId: string;
  value: unknown;
  timer: ReturnType<typeof setTimeout>;
  release(): void;
};

/** Serializes lifecycle mutations for one configured worktree without blocking unrelated worktrees. */
export function createWorktreeMutationCoordinator(
  options: CreateWorktreeMutationCoordinatorOptions = {},
): WorktreeMutationCoordinator {
  const chains = new Map<string, Promise<void>>();
  const reservations = new Map<string, ActiveReservation>();
  const reservedKeys = new Set<string>();
  const reservationTimeoutMs = options.reservationTimeoutMs ?? DEFAULT_RESERVATION_TIMEOUT_MS;
  const reservationId = options.reservationId ?? (() => `wtm_${randomUUID()}`);

  const enter = async (
    projectId: string,
    worktreeId: string,
  ): Promise<{ key: string; release(): void }> => {
    const key = mutationKey(projectId, worktreeId);
    const previous = chains.get(key) ?? Promise.resolve();
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const tail = previous.then(() => gate);
    chains.set(key, tail);
    await previous;
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        openGate();
        if (chains.get(key) === tail) {
          chains.delete(key);
        }
      },
    };
  };

  const releaseReservation = (reservation: ActiveReservation): void => {
    if (reservations.get(reservation.id) !== reservation) return;
    reservations.delete(reservation.id);
    reservedKeys.delete(mutationKey(reservation.projectId, reservation.worktreeId));
    clearTimeout(reservation.timer);
    reservation.release();
  };

  return {
    async run<T>(projectId: string, worktreeId: string, mutation: () => Promise<T>): Promise<T> {
      const slot = await enter(projectId, worktreeId);
      try {
        return await mutation();
      } finally {
        slot.release();
      }
    },

    async runUnreserved<T>(
      projectId: string,
      worktreeId: string,
      mutation: () => Promise<T>,
    ): Promise<T> {
      if (reservedKeys.has(mutationKey(projectId, worktreeId))) {
        throw worktreeReservedError(projectId, worktreeId);
      }
      const slot = await enter(projectId, worktreeId);
      try {
        return await mutation();
      } finally {
        slot.release();
      }
    },

    async reserve<T>(
      projectId: string,
      worktreeId: string,
      prepare: () => Promise<T>,
    ): Promise<WorktreeMutationReservation<T>> {
      const slot = await enter(projectId, worktreeId);
      reservedKeys.add(slot.key);
      try {
        const value = await prepare();
        const id = reservationId();
        const reservation: ActiveReservation = {
          id,
          projectId,
          worktreeId,
          value,
          timer: setTimeout(() => releaseReservation(reservation), reservationTimeoutMs),
          release: slot.release,
        };
        reservation.timer.unref?.();
        reservations.set(id, reservation);
        return { id, projectId, worktreeId, value };
      } catch (error) {
        reservedKeys.delete(slot.key);
        slot.release();
        throw error;
      }
    },

    async consume<T, R>(
      id: string,
      projectId: string,
      worktreeId: string,
      mutation: (value: T) => Promise<R>,
    ): Promise<R> {
      const reservation = reservations.get(id);
      if (
        reservation === undefined ||
        reservation.projectId !== projectId ||
        reservation.worktreeId !== worktreeId
      ) {
        throw invalidReservationError(projectId, worktreeId);
      }
      // Consumption ends only the abandonment timer; the mutation keeps the
      // acquired slot until its own terminal settlement.
      reservations.delete(id);
      clearTimeout(reservation.timer);
      try {
        return await mutation(reservation.value as T);
      } finally {
        reservedKeys.delete(mutationKey(projectId, worktreeId));
        reservation.release();
      }
    },

    cancel(id: string): boolean {
      const reservation = reservations.get(id);
      if (reservation === undefined) return false;
      releaseReservation(reservation);
      return true;
    },
  };
}

function mutationKey(projectId: string, worktreeId: string): string {
  return `${projectId}\0${worktreeId}`;
}

function worktreeReservedError(projectId: string, worktreeId: string): SafeError {
  return {
    tag: "CommandConflictError",
    code: "WORKTREE_MUTATION_RESERVED",
    message: "Another client is preparing this worktree for removal.",
    hint: "Wait for that removal attempt to settle, refresh, and retry.",
    projectId,
    worktreeId,
  };
}

function invalidReservationError(projectId: string, worktreeId: string): SafeError {
  return {
    tag: "CommandValidationError",
    code: "WORKTREE_REMOVAL_RESERVATION_INVALID",
    message: "The worktree removal reservation expired or was superseded.",
    hint: "Refresh the dashboard and confirm removal again.",
    projectId,
    worktreeId,
  };
}
