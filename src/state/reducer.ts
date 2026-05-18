import type { AppState, Manicurist } from '../types';
import type { AppAction } from './actions';
import { clientHasAnyWaxService } from '../utils/salonRules';
import { isFourthPositionSpecialService } from '../utils/priority';

function nextWaxSlot(m: Manicurist): 'hasWax' | 'hasWax2' | 'hasWax3' | null {
  if (!m.hasWax)  return 'hasWax';
  if (!m.hasWax2) return 'hasWax2';
  if (!m.hasWax3) return 'hasWax3';
  return null;
}

function nextCheckSlot(m: Manicurist): 'hasFourthPositionSpecial' | 'hasCheck2' | 'hasCheck3' | null {
  if (!m.hasFourthPositionSpecial) return 'hasFourthPositionSpecial';
  if (!m.hasCheck2)                return 'hasCheck2';
  if (!m.hasCheck3)                return 'hasCheck3';
  return null;
}

export const INITIAL_STATE: AppState = {
  manicurists: [],
  queue: [],
  completed: [],
  appointments: [],
  salonServices: [],
  turnCriteria: [],
  calendarDays: [],
  dailyHistory: [],
  staffSchedules: [],
  staffTimeOff: [],
  view: 'queue',
  modal: null,
  selectedClient: null,
  editingClientId: null,
  editingStaffId: null,
  editingAppointmentId: null,
  editingServiceId: null,
  appointmentDraft: null,
  categoryPriority: [],
  servicePriority: {},
  loaded: false,
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_VIEW':
      return { ...state, view: action.view };

    case 'SET_MODAL':
      return { ...state, modal: action.modal };

    case 'LOAD_STATE':
      return { ...state, ...action.state, loaded: true };

    case 'ADD_MANICURIST':
      return { ...state, manicurists: [...state.manicurists, action.manicurist] };

    case 'UPDATE_MANICURIST':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, ...action.updates } : m
        ),
      };

    case 'DELETE_MANICURIST':
      return {
        ...state,
        manicurists: state.manicurists.filter((m) => m.id !== action.id),
      };

    case 'CLOCK_IN':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id
            ? { ...m, clockedIn: true, clockInTime: Date.now(), status: 'available' as const }
            : m
        ),
      };

    case 'CLOCK_OUT': {
      const clockingOut = state.manicurists.find((m) => m.id === action.id);
      const clientToReturn = clockingOut?.currentClient ?? null;
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id
            ? { ...m, clockedIn: false, clockInTime: null, status: 'available' as const, currentClient: null }
            : m
        ),
        queue: clientToReturn
          ? state.queue.map((c) =>
              c.id === clientToReturn
                ? { ...c, status: 'waiting' as const, assignedManicuristId: null, startedAt: null }
                : c
            )
          : state.queue,
      };
    }

    case 'SET_BREAK':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, status: 'break' as const, breakStartTime: Date.now() } : m
        ),
      };

    case 'END_BREAK':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, status: 'available' as const, breakStartTime: null } : m
        ),
      };

    case 'ADD_CLIENT':
      return { ...state, queue: [...state.queue, action.client] };

    case 'UPDATE_CLIENT': {
      const existing = state.queue.find((c) => c.id === action.id);
      const updatedQueue = state.queue.map((c) =>
        c.id === action.id ? { ...c, ...action.updates } : c
      );
      // Turn-counter maintenance on an assigned-client edit. Two cases:
      //
      // 1) Reassignment (assignedManicuristId changed from A to B):
      //    Move the FULL turn value off A and onto B. Use whichever turnValue
      //    is supplied in updates (falling back to existing) so a combined
      //    "change staff + tweak services" edit nets out correctly. Also
      //    clear A's currentClient / status, and mark B busy with this client.
      //
      // 2) Turn-value-only edit (same staff, services or requests changed):
      //    Apply the delta to the manicurist's totalTurns so the staff-
      //    portal counter stays accurate without a CANCEL+ASSIGN round-trip.
      let updatedManicurists = state.manicurists;
      if (existing) {
        const beforeStaffId = existing.assignedManicuristId ?? null;
        const afterStaffId = action.updates.assignedManicuristId !== undefined
          ? (action.updates.assignedManicuristId ?? null)
          : beforeStaffId;
        const beforeTurns = Number(existing.turnValue) || 0;
        const afterTurns =
          action.updates.turnValue !== undefined && action.updates.turnValue !== null
            ? Number(action.updates.turnValue)
            : beforeTurns;
        const staffChanged = beforeStaffId !== afterStaffId;

        if (staffChanged) {
          updatedManicurists = state.manicurists.map((m) => {
            if (beforeStaffId && m.id === beforeStaffId) {
              return {
                ...m,
                totalTurns: Math.max(0, m.totalTurns - beforeTurns),
                status: m.currentClient === action.id ? ('available' as const) : m.status,
                currentClient: m.currentClient === action.id ? null : m.currentClient,
              };
            }
            if (afterStaffId && m.id === afterStaffId) {
              return {
                ...m,
                totalTurns: Math.max(0, m.totalTurns + afterTurns),
                status: 'busy' as const,
                currentClient: action.id,
              };
            }
            return m;
          });
        } else if (
          beforeStaffId &&
          action.updates.turnValue !== undefined &&
          afterTurns !== beforeTurns
        ) {
          const delta = afterTurns - beforeTurns;
          updatedManicurists = state.manicurists.map((m) =>
            m.id === beforeStaffId
              ? { ...m, totalTurns: Math.max(0, m.totalTurns + delta) }
              : m,
          );
        }
      }
      return {
        ...state,
        queue: updatedQueue,
        manicurists: updatedManicurists,
      };
    }

    case 'SET_EDITING_CLIENT':
      return { ...state, editingClientId: action.clientId };

    case 'REMOVE_CLIENT':
      return { ...state, queue: state.queue.filter((c) => c.id !== action.id) };

    case 'ASSIGN_CLIENT': {
      const client = state.queue.find((c) => c.id === action.clientId);
      if (!client) return state;
      const now = Date.now();
      const turns = Number(client.turnValue) || 0;
      const isWax = clientHasAnyWaxService(client.services, state.salonServices);
      const is4thPosition = isFourthPositionSpecialService(client.services, state.salonServices);
      // Reassignment case: if the client was ALREADY assigned to a different
      // manicurist, deduct turns from the old manicurist and clear their
      // currentClient / busy status. Without this the old manicurist keeps
      // the turn credit and stays stuck with a stale currentClient pointer
      // even though the work moved to someone else. Skip when reassigning
      // to the same manicurist (idempotent re-fires from the assign modal).
      const previousManicuristId =
        client.assignedManicuristId && client.assignedManicuristId !== action.manicuristId
          ? client.assignedManicuristId
          : null;
      return {
        ...state,
        queue: state.queue.map((c) =>
          c.id === action.clientId
            ? { ...c, status: 'inProgress' as const, assignedManicuristId: action.manicuristId, startedAt: now, turnValue: turns }
            : c
        ),
        manicurists: state.manicurists.map((m) => {
          if (m.id === previousManicuristId) {
            // Old assignee: deduct turns and free them up. Conservative on
            // the wax/check slots — only clear those that were set FOR this
            // client (we can't reverse-map deterministically here, so leave
            // them alone; CANCEL_SERVICE is the explicit "free this tech"
            // path that wipes them).
            return {
              ...m,
              status: m.currentClient === action.clientId ? ('available' as const) : m.status,
              currentClient: m.currentClient === action.clientId ? null : m.currentClient,
              totalTurns: Math.max(0, m.totalTurns - turns),
            };
          }
          if (m.id !== action.manicuristId) return m;
          const waxSlot   = isWax ? nextWaxSlot(m)   : null;
          const checkSlot = is4thPosition ? nextCheckSlot(m) : null;
          return {
            ...m,
            status: 'busy' as const,
            currentClient: action.clientId,
            totalTurns: m.totalTurns + turns,
            ...(checkSlot ? { [checkSlot]: true } : {}),
            ...(waxSlot   ? { [waxSlot]:   true } : {}),
          };
        }),
        selectedClient: null,
        modal: null,
      };
    }

    case 'REQUEST_ASSIGN': {
      const now = Date.now();
      const requestTurns = Number(action.client.turnValue) || 0;
      const isWax = clientHasAnyWaxService(action.client.services, state.salonServices);
      const is4thPosition = isFourthPositionSpecialService(action.client.services, state.salonServices);
      return {
        ...state,
        queue: [...state.queue, { ...action.client, status: 'inProgress' as const, assignedManicuristId: action.manicuristId, startedAt: now, turnValue: requestTurns }],
        manicurists: state.manicurists.map((m) => {
          if (m.id !== action.manicuristId) return m;
          const waxSlot   = isWax ? nextWaxSlot(m)   : null;
          const checkSlot = is4thPosition ? nextCheckSlot(m) : null;
          return {
            ...m,
            status: 'busy' as const,
            currentClient: action.client.id,
            totalTurns: m.totalTurns + requestTurns,
            ...(checkSlot ? { [checkSlot]: true } : {}),
            ...(waxSlot   ? { [waxSlot]:   true } : {}),
          };
        }),
      };
    }

    case 'SPLIT_AND_ASSIGN': {
      const now = Date.now();
      // All split children share parentQueueId = action.originalId so they
      // map to a single ticket at checkout.
      const newEntries = action.entries.map(({ client, manicuristId }) => {
        const base = { ...client, parentQueueId: action.originalId };
        if (manicuristId) {
          return { ...base, status: 'inProgress' as const, assignedManicuristId: manicuristId, startedAt: now, turnValue: client.turnValue };
        }
        return base;
      });
      // ── Turn-credit reconciliation across re-fires ─────────────────────
      // A re-run of MultiServiceAssign on a parent that's already been split
      // can move a sibling's services from manicurist A → B. Without
      // reversing A's credit, A keeps the original turns AND B gets credited
      // too — the totals visibly drift on the staff portal. Compute the
      // BEFORE state by id (any existing queue entry with the same child id
      // OR the original parent) and the AFTER state from the new entries,
      // then net out each manicurist's turn delta.
      type Slot = { staffId: string; turns: number; clientId: string };
      const beforeByChildId = new Map<string, Slot>();
      const originalEntry = state.queue.find((c) => c.id === action.originalId);
      if (originalEntry && originalEntry.assignedManicuristId) {
        beforeByChildId.set(action.originalId, {
          staffId: originalEntry.assignedManicuristId,
          turns: Number(originalEntry.turnValue) || 0,
          clientId: action.originalId,
        });
      }
      for (const c of state.queue) {
        if (c.id === action.originalId) continue;
        if (c.parentQueueId === action.originalId && c.assignedManicuristId) {
          beforeByChildId.set(c.id, {
            staffId: c.assignedManicuristId,
            turns: Number(c.turnValue) || 0,
            clientId: c.id,
          });
        }
      }
      const afterByChildId = new Map<string, Slot>();
      for (const { client, manicuristId } of action.entries) {
        if (manicuristId) {
          afterByChildId.set(client.id, {
            staffId: manicuristId,
            turns: Number(client.turnValue) || 0,
            clientId: client.id,
          });
        }
      }
      // Build per-manicurist net turn deltas + currentClient updates.
      const turnDeltaByStaff = new Map<string, number>();
      const newCurrentClientByStaff = new Map<string, string>();
      const stalePointerStaff = new Set<string>(); // staff whose currentClient pointed at a now-removed child
      for (const [childId, before] of beforeByChildId) {
        const after = afterByChildId.get(childId);
        if (after && after.staffId === before.staffId && after.turns === before.turns) continue;
        // Reverse the before-credit fully.
        turnDeltaByStaff.set(
          before.staffId,
          (turnDeltaByStaff.get(before.staffId) ?? 0) - before.turns,
        );
        if (!after) stalePointerStaff.add(before.staffId);
      }
      for (const [childId, after] of afterByChildId) {
        const before = beforeByChildId.get(childId);
        if (before && before.staffId === after.staffId && before.turns === after.turns) continue;
        turnDeltaByStaff.set(
          after.staffId,
          (turnDeltaByStaff.get(after.staffId) ?? 0) + after.turns,
        );
        newCurrentClientByStaff.set(after.staffId, after.clientId);
      }
      const newAssignmentMeta = new Map<string, { isWax: boolean; is4thPosition: boolean }>();
      for (const { client, manicuristId } of action.entries) {
        if (manicuristId) {
          newAssignmentMeta.set(manicuristId, {
            isWax: clientHasAnyWaxService(client.services, state.salonServices),
            is4thPosition: isFourthPositionSpecialService(client.services, state.salonServices),
          });
        }
      }
      // Idempotent merge by id — combined with deterministic child ids in
      // MultiServiceAssign, re-dispatching the same SPLIT_AND_ASSIGN settles
      // to the same queue state instead of duplicating children.
      //
      // ALSO drop any EXISTING child of this parent that isn't in the new
      // entries. Without this, a re-run of MultiServiceAssign that moves a
      // service from manicurist A → B leaves the old `${parent}-${A}` child
      // in the queue (its id differs from `${parent}-${B}`, so it isn't
      // overwritten by the merge below). The orphan's ticket line then sits
      // on the open ticket alongside B's freshly-appended line, which is
      // exactly the "shows BOTH manicurists" symptom seen on ticket #16.
      // syncQueue's orphan-cleanup pass picks up these removed children and
      // strips their lines off the ticket.
      const newEntryIds = new Set(newEntries.map((e) => e.id));
      const filteredQueue = state.queue.filter((c) => {
        if (c.id === action.originalId) return false;
        if (c.parentQueueId === action.originalId && !newEntryIds.has(c.id)) return false;
        return true;
      });
      const queueById = new Map(filteredQueue.map((c) => [c.id, c]));
      for (const e of newEntries) queueById.set(e.id, e);
      return {
        ...state,
        queue: Array.from(queueById.values()),
        manicurists: state.manicurists.map((m) => {
          const delta = turnDeltaByStaff.get(m.id) ?? 0;
          const newCurrent = newCurrentClientByStaff.get(m.id);
          const meta = newAssignmentMeta.get(m.id);
          // Default: no change.
          let next = m;
          if (delta !== 0) {
            next = { ...next, totalTurns: Math.max(0, next.totalTurns + delta) };
          }
          if (newCurrent) {
            const waxSlot   = meta?.isWax ? nextWaxSlot(next)   : null;
            const checkSlot = meta?.is4thPosition ? nextCheckSlot(next) : null;
            next = {
              ...next,
              status: 'busy' as const,
              currentClient: newCurrent,
              ...(checkSlot ? { [checkSlot]: true } : {}),
              ...(waxSlot   ? { [waxSlot]:   true } : {}),
            };
          } else if (stalePointerStaff.has(m.id) && !newCurrent) {
            // Old assignee whose work moved away and they got NO new client.
            // Clear their currentClient if it pointed at a now-removed child
            // and free them up.
            const oldChildIds = new Set(
              Array.from(beforeByChildId.values())
                .filter((s) => s.staffId === m.id)
                .map((s) => s.clientId),
            );
            if (next.currentClient && oldChildIds.has(next.currentClient)) {
              next = { ...next, status: 'available' as const, currentClient: null };
            }
          }
          return next;
        }),
        selectedClient: null,
        modal: null,
      };
    }

    case 'CANCEL_SERVICE': {
      const manicurist = state.manicurists.find((m) => m.id === action.manicuristId);
      if (!manicurist || !manicurist.currentClient) return state;
      const client = state.queue.find((c) => c.id === manicurist.currentClient);
      if (!client) return state;
      const turnDeduction = client.turnValue;
      return {
        ...state,
        queue: state.queue.map((c) =>
          c.id === client.id
            ? { ...c, status: 'waiting' as const, assignedManicuristId: null, startedAt: null }
            : c
        ),
        manicurists: state.manicurists.map((m) =>
          m.id === action.manicuristId
            ? { ...m, status: 'available' as const, currentClient: null, totalTurns: Math.max(0, m.totalTurns - turnDeduction), hasFourthPositionSpecial: false, hasCheck2: false, hasCheck3: false }
            : m
        ),
      };
    }

    case 'COMPLETE_SERVICE': {
      const manicurist = state.manicurists.find((m) => m.id === action.manicuristId);
      if (!manicurist || !manicurist.currentClient) return state;
      const client = state.queue.find((c) => c.id === manicurist.currentClient);
      const now = Date.now();
      const clientHadWax = client ? clientHasAnyWaxService(client.services, state.salonServices) : false;
      const updatedManicurists = state.manicurists.map((m) =>
        m.id === action.manicuristId
          ? { ...m, status: 'available' as const, currentClient: null, hasWax: clientHadWax ? true : m.hasWax }
          : m
      );
      const updatedQueue = state.queue.filter((c) => c.id !== manicurist.currentClient);
      if (!client) {
        return { ...state, manicurists: updatedManicurists, queue: updatedQueue };
      }
      // Only mark a service as requested if the completing manicurist was specifically
      // the one requested for it. Without this check, a request for Manicurist X on
      // Service A would incorrectly show an R badge on Manicurist Y's Service B entry.
      const requestedServices = (client.serviceRequests || [])
        .filter((r) => r.manicuristIds && r.manicuristIds.includes(action.manicuristId))
        .map((r) => r.service);
      // Whole-entry request flag: set when the client was requested AND this manicurist
      // is the requested one. Covers the SingleServiceAssign path where isRequested is
      // set but serviceRequests isn't populated per-service.
      const wholeEntryRequested = !!client.isRequested &&
        client.requestedManicuristId === action.manicuristId;
      // Fallback when a split-and-assign child ended up with no services in
      // its services[] (e.g. the multi-service assign distributed all services
      // to siblings and left this child empty, or a later edit cleared it).
      // Without this, History shows a blank service line for the completing
      // staff — see Candace × Tammy 2026-05-13 ticket #70. Prefer the explicit
      // services array, then fall back to the serviceRequests entries that
      // target this manicurist.
      const fallbackServicesFromRequests = (client.serviceRequests || [])
        .filter((r) => r.manicuristIds && r.manicuristIds.includes(action.manicuristId))
        .map((r) => r.service);
      const recordedServices =
        client.services && client.services.length > 0
          ? client.services
          : fallbackServicesFromRequests;
      // Deterministic ID — the queue entry's own id. A queue entry can only be
      // completed once (it's removed from the queue below), so using its id as
      // the completed_services row id makes COMPLETE_SERVICE idempotent at the
      // PRIMARY KEY layer. If two devices both fire COMPLETE_SERVICE for the
      // same queue entry, both produce the same id and the second upsert is a
      // no-op instead of a duplicate row.
      const completedEntry = {
        id: client.id,
        clientName: client.clientName,
        services: recordedServices,
        turnValue: client.turnValue,
        manicuristId: manicurist.id,
        manicuristName: manicurist.name,
        manicuristColor: manicurist.color,
        startedAt: client.startedAt ?? now,
        completedAt: now,
        requestedServices: requestedServices.length > 0 ? requestedServices : undefined,
        isAppointment: !!client.isAppointment,
        isRequested: wholeEntryRequested,
      };
      // Idempotent merge: if a row with this id already exists in completed
      // (e.g. a remote echo or a duplicate dispatch), replace it in place
      // instead of appending a second copy. Combined with the deterministic
      // id above, this makes COMPLETE_SERVICE safe to fire any number of
      // times for the same queue entry.
      const completedAlreadyExists = state.completed.some((c) => c.id === completedEntry.id);
      const nextCompleted = completedAlreadyExists
        ? state.completed.map((c) => (c.id === completedEntry.id ? completedEntry : c))
        : [...state.completed, completedEntry];
      return {
        ...state,
        queue: updatedQueue,
        manicurists: updatedManicurists,
        completed: nextCompleted,
      };
    }

    case 'SET_SELECTED_CLIENT':
      return { ...state, selectedClient: action.clientId };

    case 'SET_EDITING_STAFF':
      return { ...state, editingStaffId: action.staffId };

    case 'CLEAR_HISTORY':
      return { ...state, completed: [] };

    case 'UPDATE_COMPLETED': {
      // Edit a completed-services row in today's in-memory list. If the
      // edited entry has already been archived into dailyHistory (e.g. the
      // day was saved before the edit), update that copy too so re-opens of
      // the saved-day view reflect the change.
      // Auto-stamp `edited: true` so the row gets the EDIT badge — unless
      // the caller explicitly asked us to skip it (skipEditFlag) for
      // mechanical updates that aren't user-initiated content edits.
      const stampedUpdates = action.skipEditFlag
        ? action.updates
        : { ...action.updates, edited: true };
      const updatedCompleted = state.completed.map((c) =>
        c.id === action.id ? { ...c, ...stampedUpdates } : c
      );
      const updatedDailyHistory = state.dailyHistory.map((d) => ({
        ...d,
        entries: d.entries.map((e) =>
          e.id === action.id ? { ...e, ...stampedUpdates } : e
        ),
      }));

      // Recompute totalTurns on the affected manicurist(s). Voided entries
      // don't contribute, so reassignment, turn-value changes, and void
      // toggles all flow through the same delta math.
      const original = state.completed.find((c) => c.id === action.id);
      let updatedManicurists = state.manicurists;
      if (original) {
        const wasVoided = !!original.voided;
        const willBeVoided = action.updates.voided !== undefined ? !!action.updates.voided : wasVoided;
        const oldTurnContribution = wasVoided ? 0 : original.turnValue;
        const newTurnValue = action.updates.turnValue ?? original.turnValue;
        const newTurnContribution = willBeVoided ? 0 : newTurnValue;
        const newManicuristId = action.updates.manicuristId ?? original.manicuristId;

        if (newManicuristId !== original.manicuristId) {
          updatedManicurists = state.manicurists.map((m) => {
            if (m.id === original.manicuristId) {
              return { ...m, totalTurns: Math.max(0, m.totalTurns - oldTurnContribution) };
            }
            if (m.id === newManicuristId) {
              return { ...m, totalTurns: m.totalTurns + newTurnContribution };
            }
            return m;
          });
        } else if (newTurnContribution !== oldTurnContribution) {
          const delta = newTurnContribution - oldTurnContribution;
          updatedManicurists = state.manicurists.map((m) =>
            m.id === original.manicuristId
              ? { ...m, totalTurns: Math.max(0, m.totalTurns + delta) }
              : m
          );
        }
      }

      return {
        ...state,
        completed: updatedCompleted,
        dailyHistory: updatedDailyHistory,
        manicurists: updatedManicurists,
      };
    }

    case 'TOGGLE_VOID_COMPLETED': {
      // Soft-delete: flip voided flag, keep the row visible, and adjust
      // totalTurns since voided rows don't count toward a manicurist's total.
      const original = state.completed.find((c) => c.id === action.id)
        ?? state.dailyHistory.flatMap((d) => d.entries).find((e) => e.id === action.id);
      if (!original) return state;
      const willBeVoided = !original.voided;
      const delta = willBeVoided ? -original.turnValue : original.turnValue;
      const updatedManicurists = state.manicurists.map((m) =>
        m.id === original.manicuristId
          ? { ...m, totalTurns: Math.max(0, m.totalTurns + delta) }
          : m
      );
      return {
        ...state,
        completed: state.completed.map((c) =>
          c.id === action.id ? { ...c, voided: willBeVoided } : c
        ),
        dailyHistory: state.dailyHistory.map((d) => ({
          ...d,
          entries: d.entries.map((e) =>
            e.id === action.id ? { ...e, voided: willBeVoided } : e
          ),
        })),
        manicurists: updatedManicurists,
      };
    }

    case 'DELETE_COMPLETED': {
      const original = state.completed.find((c) => c.id === action.id);
      // Voided entries already had their turns subtracted, so don't double-subtract.
      const updatedManicurists = original && !original.voided
        ? state.manicurists.map((m) =>
            m.id === original.manicuristId
              ? { ...m, totalTurns: Math.max(0, m.totalTurns - original.turnValue) }
              : m
          )
        : state.manicurists;
      return {
        ...state,
        completed: state.completed.filter((c) => c.id !== action.id),
        dailyHistory: state.dailyHistory.map((d) => ({
          ...d,
          entries: d.entries.filter((e) => e.id !== action.id),
        })),
        manicurists: updatedManicurists,
      };
    }

    case 'ADD_APPOINTMENT':
      return { ...state, appointments: [...state.appointments, action.appointment] };

    case 'UPDATE_APPOINTMENT':
      // Every UPDATE bumps lastEditedAt. lastEditedByReceptionistId is set
      // by callers that already gathered the receptionist id via the PIN
      // gate; we pass it through verbatim. If the caller didn't supply it
      // (legacy code paths) the field stays as-is.
      return {
        ...state,
        appointments: state.appointments.map((a) =>
          a.id === action.id
            ? { ...a, ...action.updates, lastEditedAt: Date.now() }
            : a
        ),
      };

    case 'DELETE_APPOINTMENT':
      return {
        ...state,
        appointments: state.appointments.filter((a) => a.id !== action.id),
      };

    case 'SET_EDITING_APPOINTMENT':
      return { ...state, editingAppointmentId: action.appointmentId };

    case 'SET_APPOINTMENT_DRAFT':
      return { ...state, appointmentDraft: action.draft };

    case 'ADD_SALON_SERVICE':
      return { ...state, salonServices: [...state.salonServices, action.service] };

    case 'UPDATE_SALON_SERVICE':
      return {
        ...state,
        salonServices: state.salonServices.map((s) =>
          s.id === action.id ? { ...s, ...action.updates } : s
        ),
      };

    case 'DELETE_SALON_SERVICE':
      return {
        ...state,
        salonServices: state.salonServices.filter((s) => s.id !== action.id),
      };

    case 'SET_EDITING_SERVICE':
      return { ...state, editingServiceId: action.serviceId };

    case 'UPDATE_TURN_CRITERIA':
      return {
        ...state,
        turnCriteria: state.turnCriteria.map((c) =>
          c.id === action.criteria.id ? action.criteria : c
        ),
      };

    case 'SET_TURN_CRITERIA':
      return { ...state, turnCriteria: action.criteria };

    case 'SET_CALENDAR_DAY': {
      const existing = state.calendarDays.findIndex((d) => d.date === action.day.date);
      if (existing >= 0) {
        return {
          ...state,
          calendarDays: state.calendarDays.map((d) =>
            d.date === action.day.date ? action.day : d
          ),
        };
      }
      return { ...state, calendarDays: [...state.calendarDays, action.day] };
    }

    case 'REMOVE_CALENDAR_DAY':
      return {
        ...state,
        calendarDays: state.calendarDays.filter((d) => d.date !== action.date),
      };

    case 'REORDER_MANICURIST': {
      const list = [...state.manicurists];
      const idx = list.findIndex((m) => m.id === action.id);
      if (idx < 0) return state;
      const swapIdx = action.direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= list.length) return state;
      [list[idx], list[swapIdx]] = [list[swapIdx], list[idx]];
      return { ...state, manicurists: list };
    }

    case 'SET_MANICURIST_ORDER': {
      const ordered = action.ids
        .map((id) => state.manicurists.find((m) => m.id === id))
        .filter(Boolean) as typeof state.manicurists;
      const rest = state.manicurists.filter((m) => !action.ids.includes(m.id));
      return { ...state, manicurists: [...ordered, ...rest] };
    }

    case 'TOGGLE_FOURTH_POSITION_SPECIAL':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, hasFourthPositionSpecial: !m.hasFourthPositionSpecial } : m
        ),
      };

    case 'TOGGLE_CHECK2':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, hasCheck2: !m.hasCheck2 } : m
        ),
      };

    case 'TOGGLE_CHECK3':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, hasCheck3: !m.hasCheck3 } : m
        ),
      };

    case 'TOGGLE_WAX':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, hasWax: !m.hasWax } : m
        ),
      };

    case 'TOGGLE_WAX2':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, hasWax2: !m.hasWax2 } : m
        ),
      };

    case 'TOGGLE_WAX3':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, hasWax3: !m.hasWax3 } : m
        ),
      };

    case 'REORDER_SALON_SERVICE': {
      const target = state.salonServices.find((s) => s.id === action.id);
      if (!target) return state;
      const catList = [...state.salonServices]
        .filter((s) => s.category === target.category)
        .sort((a, b) => a.sortOrder - b.sortOrder);
      const idx = catList.findIndex((s) => s.id === action.id);
      if (idx < 0) return state;
      const swapIdx = action.direction === 'up' ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= catList.length) return state;
      const tempOrder = catList[idx].sortOrder;
      const swapOrder = catList[swapIdx].sortOrder;
      return {
        ...state,
        salonServices: state.salonServices.map((s) => {
          if (s.id === catList[idx].id) return { ...s, sortOrder: swapOrder };
          if (s.id === catList[swapIdx].id) return { ...s, sortOrder: tempOrder };
          return s;
        }),
      };
    }

    case 'SET_SALON_SERVICE_ORDER': {
      // Bulk reorder used by drag-and-drop. The action carries the new ID
      // ordering for a single category; we preserve the existing sortOrder
      // numeric values (keeping spacing relative to other categories) and
      // permute which service holds which value.
      const ids = action.ids;
      const services = ids
        .map((id) => state.salonServices.find((s) => s.id === id))
        .filter(Boolean) as typeof state.salonServices;
      if (services.length !== ids.length || services.length === 0) return state;
      const sortValues = services.map((s) => s.sortOrder).slice().sort((a, b) => a - b);
      const newOrderById = new Map<string, number>();
      ids.forEach((id, i) => newOrderById.set(id, sortValues[i]));
      return {
        ...state,
        salonServices: state.salonServices.map((s) =>
          newOrderById.has(s.id) ? { ...s, sortOrder: newOrderById.get(s.id)! } : s,
        ),
      };
    }

    case 'DAILY_RESET':
      return {
        ...state,
        queue: [],
        completed: [],
        manicurists: state.manicurists.map((m) => ({
          ...m,
          totalTurns: 0,
          clockedIn: false,
          clockInTime: null,
          currentClient: null,
          status: 'available' as const,
          hasFourthPositionSpecial: false,
          hasCheck2: false,
          hasCheck3: false,
          hasWax: false,
          hasWax2: false,
          hasWax3: false,
        })),
      };

    case 'SAVE_DAILY_HISTORY': {
      const existing = state.dailyHistory.findIndex((d) => d.date === action.entry.date)
      if (existing >= 0) {
        return {
          ...state,
          dailyHistory: state.dailyHistory.map((d) => d.date === action.entry.date ? action.entry : d),
        };
      }
      return {
        ...state,
        dailyHistory: [...state.dailyHistory, action.entry],
      };
    }

    // --- Remote-sync handlers ---
    // Each replaces-or-inserts by id. Idempotent: if the row hasn't materially changed,
    // the merge still produces a fresh state reference, but the AppContext sync effect
    // will skip its DB flush because the `isApplyingRemoteRef` flag is set by the caller.
    case 'REMOTE_MANICURIST_UPSERT': {
      const idx = state.manicurists.findIndex((m) => m.id === action.manicurist.id);
      if (idx === -1) return { ...state, manicurists: [...state.manicurists, action.manicurist] };
      return { ...state, manicurists: state.manicurists.map((m, i) => i === idx ? action.manicurist : m) };
    }

    case 'REMOTE_MANICURIST_DELETE':
      return { ...state, manicurists: state.manicurists.filter((m) => m.id !== action.id) };

    case 'REMOTE_QUEUE_UPSERT': {
      const idx = state.queue.findIndex((c) => c.id === action.entry.id);
      if (idx === -1) return { ...state, queue: [...state.queue, action.entry] };
      return { ...state, queue: state.queue.map((c, i) => i === idx ? action.entry : c) };
    }

    case 'REMOTE_QUEUE_DELETE':
      return { ...state, queue: state.queue.filter((c) => c.id !== action.id) };

    case 'REMOTE_COMPLETED_UPSERT': {
      const idx = state.completed.findIndex((c) => c.id === action.entry.id);
      if (idx === -1) return { ...state, completed: [...state.completed, action.entry] };
      return { ...state, completed: state.completed.map((c, i) => i === idx ? action.entry : c) };
    }

    case 'REMOTE_COMPLETED_DELETE':
      return { ...state, completed: state.completed.filter((c) => c.id !== action.id) };

    case 'REMOTE_APPOINTMENT_UPSERT': {
      const idx = state.appointments.findIndex((a) => a.id === action.appointment.id);
      if (idx === -1) return { ...state, appointments: [...state.appointments, action.appointment] };
      return { ...state, appointments: state.appointments.map((a, i) => i === idx ? action.appointment : a) };
    }

    case 'REMOTE_APPOINTMENT_DELETE':
      return { ...state, appointments: state.appointments.filter((a) => a.id !== action.id) };

    case 'REMOTE_SALON_SERVICE_UPSERT': {
      const idx = state.salonServices.findIndex((s) => s.id === action.service.id);
      if (idx === -1) return { ...state, salonServices: [...state.salonServices, action.service] };
      return { ...state, salonServices: state.salonServices.map((s, i) => i === idx ? action.service : s) };
    }

    case 'REMOTE_SALON_SERVICE_DELETE':
      return { ...state, salonServices: state.salonServices.filter((s) => s.id !== action.id) };

    case 'REMOTE_TURN_CRITERIA_UPSERT': {
      const idx = state.turnCriteria.findIndex((c) => c.id === action.criteria.id);
      if (idx === -1) return { ...state, turnCriteria: [...state.turnCriteria, action.criteria] };
      return { ...state, turnCriteria: state.turnCriteria.map((c, i) => i === idx ? action.criteria : c) };
    }

    case 'REMOTE_TURN_CRITERIA_DELETE':
      return { ...state, turnCriteria: state.turnCriteria.filter((c) => c.id !== action.id) };

    case 'REMOTE_CALENDAR_DAY_UPSERT': {
      const idx = state.calendarDays.findIndex((d) => d.date === action.day.date);
      if (idx === -1) return { ...state, calendarDays: [...state.calendarDays, action.day] };
      return { ...state, calendarDays: state.calendarDays.map((d, i) => i === idx ? action.day : d) };
    }

    case 'REMOTE_CALENDAR_DAY_DELETE':
      return { ...state, calendarDays: state.calendarDays.filter((d) => d.date !== action.date) };

    case 'REMOTE_SYSTEM_STATE_UPDATE':
      // system_state is a singleton whose only field the app reads (last_archive_date) is
      // consulted on startup directly from the DB. There's no local state to update here;
      // we keep the case so the subscription handler can dispatch uniformly for every table.
      return state;

    case 'SET_PRIORITY': {
      const next: AppState = { ...state };
      if (action.categoryPriority !== undefined) next.categoryPriority = action.categoryPriority;
      if (action.servicePriority !== undefined) next.servicePriority = action.servicePriority;
      return next;
    }

    // ─── Staff schedules / time off ───────────────────────────────────────
    case 'SET_STAFF_SCHEDULE_DAY': {
      const e = action.entry;
      const idx = state.staffSchedules.findIndex(
        (s) => s.manicuristId === e.manicuristId && s.weekday === e.weekday
      );
      if (idx >= 0) {
        const next = state.staffSchedules.slice();
        next[idx] = e;
        return { ...state, staffSchedules: next };
      }
      return { ...state, staffSchedules: [...state.staffSchedules, e] };
    }

    case 'CLEAR_STAFF_SCHEDULE_DAY':
      return {
        ...state,
        staffSchedules: state.staffSchedules.filter(
          (s) => !(s.manicuristId === action.manicuristId && s.weekday === action.weekday)
        ),
      };

    case 'ADD_STAFF_TIME_OFF':
      return { ...state, staffTimeOff: [...state.staffTimeOff, action.entry] };

    case 'UPDATE_STAFF_TIME_OFF':
      return {
        ...state,
        staffTimeOff: state.staffTimeOff.map((t) =>
          t.id === action.id ? { ...t, ...action.updates } : t
        ),
      };

    case 'DELETE_STAFF_TIME_OFF':
      return {
        ...state,
        staffTimeOff: state.staffTimeOff.filter((t) => t.id !== action.id),
      };

    case 'REMOTE_STAFF_SCHEDULE_UPSERT': {
      const e = action.entry;
      const idx = state.staffSchedules.findIndex((s) => s.id === e.id);
      if (idx >= 0) {
        const next = state.staffSchedules.slice();
        next[idx] = e;
        return { ...state, staffSchedules: next };
      }
      // Also dedupe on (manicuristId, weekday) since UNIQUE constraint may have rebuilt id
      const dupIdx = state.staffSchedules.findIndex(
        (s) => s.manicuristId === e.manicuristId && s.weekday === e.weekday
      );
      if (dupIdx >= 0) {
        const next = state.staffSchedules.slice();
        next[dupIdx] = e;
        return { ...state, staffSchedules: next };
      }
      return { ...state, staffSchedules: [...state.staffSchedules, e] };
    }

    case 'REMOTE_STAFF_SCHEDULE_DELETE':
      return {
        ...state,
        staffSchedules: state.staffSchedules.filter((s) => s.id !== action.id),
      };

    case 'REMOTE_STAFF_TIME_OFF_UPSERT': {
      const e = action.entry;
      const idx = state.staffTimeOff.findIndex((t) => t.id === e.id);
      if (idx >= 0) {
        const next = state.staffTimeOff.slice();
        next[idx] = e;
        return { ...state, staffTimeOff: next };
      }
      return { ...state, staffTimeOff: [...state.staffTimeOff, e] };
    }

    case 'REMOTE_STAFF_TIME_OFF_DELETE':
      return {
        ...state,
        staffTimeOff: state.staffTimeOff.filter((t) => t.id !== action.id),
      };

    default:
      return state;
  }
}
