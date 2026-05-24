import type { AppState, Appointment, Manicurist, QueueEntry } from '../types';
import type { AppAction } from './actions';
import { clientHasAnyWaxService } from '../utils/salonRules';
import { isFourthPositionSpecialService } from '../utils/priority';
import { getLocalDateStr } from '../utils/time';

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

// === Walk-in auto-appt-slot helpers ─────────────────────────────────────
// When a queue entry without a linked appointment gets assigned to a
// manicurist, we synthesize a corresponding appointment-book block so the
// walk-in flows through the same in-service → checked-out lifecycle as
// Q'd-from-book appointments. The block lands in the assigned manicurist's
// column at the current LA wall-clock time rounded to the nearest 15 min;
// if that slot is already occupied (another booking starts at that exact
// time in this column), we walk forward in 15-min steps until a free slot
// is found, capping at 4 hours to avoid spinning.

function roundLATimeToQuarter(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const total = h * 60 + m;
  const safe = Math.min(Math.round(total / 15) * 15, 23 * 60 + 45);
  const hh = Math.floor(safe / 60);
  const mm = safe % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function pickNextOpenSlot(
  date: string,
  manicuristId: string,
  startHHMM: string,
  appts: Appointment[],
): string {
  const taken = new Set(
    appts
      .filter(
        (a) =>
          a.date === date &&
          a.manicuristId === manicuristId &&
          a.status !== 'cancelled' &&
          a.status !== 'no-show',
      )
      .map((a) => a.time),
  );
  const [sh, sm] = startHHMM.split(':').map(Number);
  let total = sh * 60 + sm;
  for (let i = 0; i < 16; i++) {
    const hh = Math.floor(total / 60);
    if (hh >= 24) break;
    const mm = total % 60;
    const candidate = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (!taken.has(candidate)) return candidate;
    total += 15;
  }
  // No free slot in the next 4 hours — drop to the 8 AM anchor slot, which
  // is reliably empty (salon opens at 8). The receptionist drags it to the
  // right place when convenient.
  return '08:00';
}

// Same-minute buddy alignment window. Two non-request walk-ins assigned to
// different manicurists within this many ms of each other are placed on the
// same time row in the appt book so the receptionist sees them as a visual
// group (they typically arrive together — e.g., a mom + daughter splitting
// to two open techs). 60s matches the "same minute" UX phrasing.
const WALK_IN_BUDDY_WINDOW_MS = 60_000;

function findBuddyWalkInTime(
  manicuristId: string,
  date: string,
  appts: Appointment[],
  nowMs: number,
): string | null {
  let bestTime: string | null = null;
  let bestCreatedAt = -Infinity;
  for (const a of appts) {
    if (!a.isWalkIn) continue;
    if (a.date !== date) continue;
    if (a.manicuristId === manicuristId) continue;
    if (typeof a.createdAt !== 'number') continue;
    if (nowMs - a.createdAt > WALK_IN_BUDDY_WINDOW_MS) continue;
    if (a.createdAt > bestCreatedAt) {
      bestCreatedAt = a.createdAt;
      bestTime = a.time;
    }
  }
  return bestTime;
}

function synthWalkInAppt(
  client: QueueEntry,
  manicuristId: string,
  appts: Appointment[],
  now: Date = new Date(),
): Appointment {
  const date = getLocalDateStr(now);
  // Floor the search to 08:00 — the salon doesn't open before then and the
  // appt book grid doesn't render slots earlier in the day. Without this,
  // any walk-in added pre-open (or pre-rounded-08:00) lands at e.g. 06:15
  // and is invisible above the book's first visible slot.
  const rounded = roundLATimeToQuarter(now);
  // Non-request walk-ins prefer to align with a "buddy" walk-in placed on
  // another manicurist within the last minute, so the receptionist sees the
  // pair as a single horizontal group in the appt book. Request walk-ins
  // skip this — those are intentionally individual requests, not a group.
  const isRequest = !!client.isRequested;
  const buddyTime =
    !isRequest ? findBuddyWalkInTime(manicuristId, date, appts, now.getTime()) : null;
  const preferred = buddyTime ?? rounded;
  const start = preferred < '08:00' ? '08:00' : preferred;
  const time = pickNextOpenSlot(date, manicuristId, start, appts);
  // sameTime flags appointments that are intentionally on the same time row
  // as another appt (visual stacking instead of "conflict?" warnings). Set
  // it when the buddy alignment actually landed us on the buddy's row.
  const alignedWithBuddy = buddyTime !== null && time === buddyTime;
  return {
    id: crypto.randomUUID(),
    clientName: client.clientName,
    clientPhone: '',
    service: client.services[0] || '',
    services: client.services,
    serviceRequests: client.serviceRequests || [],
    manicuristId,
    date,
    time,
    notes: '',
    status: 'checked-in',
    createdAt: now.getTime(),
    sameTime: alignedWithBuddy,
    partyId: null,
    isWalkIn: true,
  };
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
  staffScheduleOverrides: [],
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
      // Mirror relevant queue-side changes back onto the linked appt block
      // so the appointment book stays accurate. We sync services (string
      // array), serviceRequests (the per-service request list), and
      // manicuristId (on reassign). Only fires when the entry actually has
      // a linked appt (`originalAppointment.id` exists in state.appointments).
      let updatedAppointments = state.appointments;
      const linkedApptIdForUpdate = existing?.originalAppointment?.id;
      if (linkedApptIdForUpdate) {
        const linkedAppt = state.appointments.find((a) => a.id === linkedApptIdForUpdate);
        if (linkedAppt) {
          const apptPatch: Partial<typeof linkedAppt> = {};
          if (action.updates.services !== undefined) {
            apptPatch.services = action.updates.services;
            apptPatch.service = action.updates.services[0] ?? linkedAppt.service;
          }
          if (action.updates.serviceRequests !== undefined) {
            apptPatch.serviceRequests = action.updates.serviceRequests;
          }
          if (action.updates.assignedManicuristId !== undefined) {
            apptPatch.manicuristId = action.updates.assignedManicuristId ?? null;
          }
          if (Object.keys(apptPatch).length > 0) {
            updatedAppointments = state.appointments.map((a) =>
              a.id === linkedApptIdForUpdate ? { ...a, ...apptPatch } : a,
            );
          }
        }
      }
      return {
        ...state,
        queue: updatedQueue,
        manicurists: updatedManicurists,
        appointments: updatedAppointments,
      };
    }

    case 'SET_EDITING_CLIENT':
      return { ...state, editingClientId: action.clientId };

    case 'REMOVE_CLIENT': {
      const removed = state.queue.find((c) => c.id === action.id);
      // If the removed entry has a linked walk-in appt block that the
      // receptionist hasn't drag-confirmed yet (appt.isWalkIn still true),
      // delete it from the book too — there's no client to serve anymore.
      // Drag-confirmed appts (isWalkIn cleared) stay.
      const linkedApptId = removed?.originalAppointment?.id;
      const linkedAppt = linkedApptId
        ? state.appointments.find((a) => a.id === linkedApptId)
        : null;
      const shouldDeleteAppt = !!(linkedAppt && linkedAppt.isWalkIn);
      return {
        ...state,
        queue: state.queue.filter((c) => c.id !== action.id),
        appointments: shouldDeleteAppt
          ? state.appointments.filter((a) => a.id !== linkedApptId)
          : state.appointments,
      };
    }

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
      // Orphan-prevention case: when the NEW assignee was ALREADY busy
      // with a DIFFERENT in-progress queue entry, that entry would
      // otherwise stay pinned to them (assigned_manicurist_id unchanged,
      // status 'inProgress', turn credit kept) even though the manicurist's
      // currentClient pointer moves to the new client and the prior card
      // disappears from the UI. We unwind the prior assignment: drop the
      // entry back to 'waiting' so a receptionist can re-assign it, and
      // deduct the prior turn credit from the manicurist's totalTurns.
      // Skip split/add-children (parentQueueId set) — those have their own
      // dedicated cleanup paths in TicketModal (handleProcess /
      // handleVoidConfirmed) and aren't real top-level queue entries.
      // Symptom of the old behavior: Joe shows total_turns=4 but History
      // only lists 1 service; 2 in-progress orphan queue entries
      // (Cynthia, Reese) sit assigned to him forever — 2026-05-21.
      const newAssignee = state.manicurists.find((m) => m.id === action.manicuristId);
      const orphanCandidateId =
        newAssignee && newAssignee.currentClient && newAssignee.currentClient !== action.clientId
          ? newAssignee.currentClient
          : null;
      const orphanedEntry = orphanCandidateId
        ? state.queue.find((c) => c.id === orphanCandidateId && !c.parentQueueId)
        : null;
      const orphanedTurns = orphanedEntry ? Number(orphanedEntry.turnValue) || 0 : 0;
      // Walk-in flow: if this entry isn't linked to an appointment yet,
      // synthesize one in the assigned manicurist's column so the walk-in
      // lives in the appt book and can be checked out from there. On
      // re-assign (originalAppointment already exists in state.appointments),
      // update the existing block's manicuristId so it moves to the new
      // column instead of duplicating.
      const existingAppt = client.originalAppointment
        ? state.appointments.find((a) => a.id === client.originalAppointment!.id)
        : null;
      const synthAppt = !client.originalAppointment
        ? synthWalkInAppt(client, action.manicuristId, state.appointments)
        : null;
      const nextAppointments = synthAppt
        ? [...state.appointments, synthAppt]
        : existingAppt && existingAppt.manicuristId !== action.manicuristId
          ? state.appointments.map((a) =>
              a.id === existingAppt.id ? { ...a, manicuristId: action.manicuristId } : a,
            )
          : state.appointments;
      return {
        ...state,
        appointments: nextAppointments,
        queue: state.queue.map((c) => {
          if (c.id === action.clientId) {
            return {
              ...c,
              status: 'inProgress' as const,
              assignedManicuristId: action.manicuristId,
              startedAt: now,
              turnValue: turns,
              originalAppointment: synthAppt ?? c.originalAppointment,
            };
          }
          if (orphanedEntry && c.id === orphanedEntry.id) {
            return { ...c, status: 'waiting' as const, assignedManicuristId: null, startedAt: null };
          }
          return c;
        }),
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
          // Net turn delta: credit the new client's turns, refund the
          // orphan-unwound prior client's turns (zero when there wasn't one).
          return {
            ...m,
            status: 'busy' as const,
            currentClient: action.clientId,
            totalTurns: Math.max(0, m.totalTurns - orphanedTurns + turns),
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
      // Same orphan-prevention as ASSIGN_CLIENT — if the requested
      // manicurist was already busy with a different top-level queue
      // entry, drop that entry back to waiting and refund its turn credit.
      const requestAssignee = state.manicurists.find((m) => m.id === action.manicuristId);
      const requestOrphanCandidateId =
        requestAssignee && requestAssignee.currentClient && requestAssignee.currentClient !== action.client.id
          ? requestAssignee.currentClient
          : null;
      const requestOrphanedEntry = requestOrphanCandidateId
        ? state.queue.find((c) => c.id === requestOrphanCandidateId && !c.parentQueueId)
        : null;
      const requestOrphanedTurns = requestOrphanedEntry ? Number(requestOrphanedEntry.turnValue) || 0 : 0;
      // Walk-in flow: synthesize an appt-book block for this freshly-
      // requested client (REQUEST_ASSIGN always seeds a brand-new queue
      // entry, so originalAppointment is never set here).
      const requestSynthAppt = !action.client.originalAppointment
        ? synthWalkInAppt(action.client, action.manicuristId, state.appointments)
        : null;
      return {
        ...state,
        appointments: requestSynthAppt
          ? [...state.appointments, requestSynthAppt]
          : state.appointments,
        queue: [
          ...state.queue.map((c) =>
            requestOrphanedEntry && c.id === requestOrphanedEntry.id
              ? { ...c, status: 'waiting' as const, assignedManicuristId: null, startedAt: null }
              : c
          ),
          {
            ...action.client,
            status: 'inProgress' as const,
            assignedManicuristId: action.manicuristId,
            startedAt: now,
            turnValue: requestTurns,
            originalAppointment: requestSynthAppt ?? action.client.originalAppointment,
          },
        ],
        manicurists: state.manicurists.map((m) => {
          if (m.id !== action.manicuristId) return m;
          const waxSlot   = isWax ? nextWaxSlot(m)   : null;
          const checkSlot = is4thPosition ? nextCheckSlot(m) : null;
          return {
            ...m,
            status: 'busy' as const,
            currentClient: action.client.id,
            totalTurns: Math.max(0, m.totalTurns - requestOrphanedTurns + requestTurns),
            ...(checkSlot ? { [checkSlot]: true } : {}),
            ...(waxSlot   ? { [waxSlot]:   true } : {}),
          };
        }),
      };
    }

    case 'SPLIT_AND_ASSIGN': {
      const now = Date.now();
      // Inherit the parent's appointment-book linkage so split children
      // don't get mistaken for fresh walk-ins (which would trigger a synth
      // appt per child and duplicate the block already in the book).
      // MultiServiceAssign / TicketModal / StaffPortalScreen build the
      // child entries without copying `originalAppointment`, so we do it
      // here in the reducer — one place, every caller.
      const splitParent = state.queue.find((c) => c.id === action.originalId);
      const parentOriginalAppt = splitParent?.originalAppointment;
      // All split children share parentQueueId = action.originalId so they
      // map to a single ticket at checkout.
      const newEntries = action.entries.map(({ client, manicuristId }) => {
        const base = {
          ...client,
          parentQueueId: action.originalId,
          // Children inherit parent's originalAppointment unless the caller
          // explicitly supplied one on the child entry.
          originalAppointment: client.originalAppointment ?? parentOriginalAppt,
        };
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
      // Walk-in flow: synthesize one appt-book block per assigned split
      // child. Accumulate into apptAcc as we go so siblings don't get
      // dropped on the same time slot in the same manicurist's column.
      // Skip children that already have an originalAppointment (e.g. the
      // parent was Q'd from the book) and children with no manicuristId.
      const apptAcc: Appointment[] = [...state.appointments];
      const synthApptByChildId = new Map<string, Appointment>();
      for (const e of newEntries) {
        if (!e.assignedManicuristId) continue;
        if (e.originalAppointment) continue;
        const appt = synthWalkInAppt(e, e.assignedManicuristId, apptAcc);
        synthApptByChildId.set(e.id, appt);
        apptAcc.push(appt);
      }
      const queueById = new Map(filteredQueue.map((c) => [c.id, c]));
      for (const e of newEntries) {
        const synth = synthApptByChildId.get(e.id);
        queueById.set(e.id, synth ? { ...e, originalAppointment: synth } : e);
      }
      return {
        ...state,
        appointments: apptAcc,
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
      const currentClientId = manicurist.currentClient;
      const client = state.queue.find((c) => c.id === currentClientId);

      // Add-child detection: synthetic queue entries created by the ticket
      // modal carry an id of `${visitId}-add-${staffId}`. They aren't real
      // walk-in queue rows — they exist only to surface the service on the
      // staff card. Cancelling one should REMOVE the entry outright (not
      // mark it waiting), and NOT deduct turn credit (those entries always
      // carry turnValue=0; turn rollback for added lines is handled by
      // reallocateTurnsForStaffChanges on ticket save).
      const isAddChild = /-add-/.test(currentClientId);

      // Phantom-pointer recovery: if the manicurist's currentClient points
      // at an id that doesn't exist in the local queue (e.g. the queue
      // entry was deleted server-side, or the realtime DELETE arrived
      // before this dispatch), just free the manicurist. Without this
      // branch the reducer early-returns and the manicurist stays stuck
      // BUSY on a dead pointer with no way to reset short of an app
      // refresh — exactly the symptom Z-TEST 4 hit on ticket #2.
      if (!client) {
        return {
          ...state,
          manicurists: state.manicurists.map((m) =>
            m.id === action.manicuristId
              ? { ...m, status: 'available' as const, currentClient: null, hasFourthPositionSpecial: false, hasCheck2: false, hasCheck3: false }
              : m
          ),
        };
      }

      const turnDeduction = isAddChild ? 0 : client.turnValue;
      const updatedQueue = isAddChild
        ? state.queue.filter((c) => c.id !== client.id)
        : state.queue.map((c) =>
            c.id === client.id
              ? { ...c, status: 'waiting' as const, assignedManicuristId: null, startedAt: null }
              : c
          );
      // If the cancelled service was an auto-placed walk-in (still flagged
      // isWalkIn=true on the appt — meaning the receptionist hasn't drag-
      // confirmed it yet), drop the appt block from the book. The client
      // is going back to waiting OR being removed entirely; either way the
      // synth block has no reason to keep occupying a slot.
      const cancelApptId = client.originalAppointment?.id;
      const cancelApptStill = cancelApptId
        ? state.appointments.find((a) => a.id === cancelApptId)
        : null;
      const cancelDeleteAppt = !!(cancelApptStill && cancelApptStill.isWalkIn);
      return {
        ...state,
        queue: updatedQueue,
        appointments: cancelDeleteAppt
          ? state.appointments.filter((a) => a.id !== cancelApptId)
          : state.appointments,
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
        // Link back to the appointment book entry so the register can flip the
        // appt to 'completed' (black) when the ticket is closed.
        originalAppointmentId: client.originalAppointment?.id,
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
      // DO NOT flip the linked appointment to 'completed' here. Per user
      // request 2026-05-22, the appt should stay light gray (in-service color)
      // until the register ticket is actually closed. The 'completed' flip now
      // lives in TicketModal.handleProcess after closeTicket() succeeds, which
      // looks up the linked appt via state.completed[].originalAppointmentId.
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

    // ─── Per-date schedule overrides ──────────────────────────────────────
    case 'SET_STAFF_SCHEDULE_OVERRIDE': {
      const e = action.entry;
      // Upsert keyed by (manicuristId, date). Two paths because the entry
      // arriving from the local UI uses a freshly-minted id, while a
      // re-save of an existing override comes through with the prior id —
      // either way we collapse onto the single per-date row.
      const byId = state.staffScheduleOverrides.findIndex((o) => o.id === e.id);
      if (byId >= 0) {
        const next = state.staffScheduleOverrides.slice();
        next[byId] = e;
        return { ...state, staffScheduleOverrides: next };
      }
      const byPair = state.staffScheduleOverrides.findIndex(
        (o) => o.manicuristId === e.manicuristId && o.date === e.date,
      );
      if (byPair >= 0) {
        const next = state.staffScheduleOverrides.slice();
        next[byPair] = e;
        return { ...state, staffScheduleOverrides: next };
      }
      return { ...state, staffScheduleOverrides: [...state.staffScheduleOverrides, e] };
    }

    case 'CLEAR_STAFF_SCHEDULE_OVERRIDE':
      return {
        ...state,
        staffScheduleOverrides: state.staffScheduleOverrides.filter(
          (o) => !(o.manicuristId === action.manicuristId && o.date === action.date),
        ),
      };

    case 'REMOTE_STAFF_SCHEDULE_OVERRIDE_UPSERT': {
      const e = action.entry;
      const idx = state.staffScheduleOverrides.findIndex((o) => o.id === e.id);
      if (idx >= 0) {
        const next = state.staffScheduleOverrides.slice();
        next[idx] = e;
        return { ...state, staffScheduleOverrides: next };
      }
      // Same dedup-by-(mid,date) as the local SET case so realtime echoes
      // from another tab don't double-insert when the UNIQUE constraint
      // assigned a different id than what we minted locally.
      const dupIdx = state.staffScheduleOverrides.findIndex(
        (o) => o.manicuristId === e.manicuristId && o.date === e.date,
      );
      if (dupIdx >= 0) {
        const next = state.staffScheduleOverrides.slice();
        next[dupIdx] = e;
        return { ...state, staffScheduleOverrides: next };
      }
      return { ...state, staffScheduleOverrides: [...state.staffScheduleOverrides, e] };
    }

    case 'REMOTE_STAFF_SCHEDULE_OVERRIDE_DELETE':
      return {
        ...state,
        staffScheduleOverrides: state.staffScheduleOverrides.filter((o) => o.id !== action.id),
      };

    default:
      return state;
  }
}
