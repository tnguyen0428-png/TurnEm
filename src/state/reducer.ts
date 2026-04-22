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
  view: 'queue',
  modal: null,
  selectedClient: null,
  editingClientId: null,
  editingStaffId: null,
  editingAppointmentId: null,
  editingServiceId: null,
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
            ? { ...m, clockedIn: false, clockInTime: null, status: 'available' as const, currentClient: null, totalTurns: 0 }
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
          m.id === action.id ? { ...m, status: 'break' as const } : m
        ),
      };

    case 'END_BREAK':
      return {
        ...state,
        manicurists: state.manicurists.map((m) =>
          m.id === action.id ? { ...m, status: 'available' as const } : m
        ),
      };

    case 'ADD_CLIENT':
      return { ...state, queue: [...state.queue, action.client] };

    case 'UPDATE_CLIENT':
      return {
        ...state,
        queue: state.queue.map((c) =>
          c.id === action.id ? { ...c, ...action.updates } : c
        ),
      };

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
      return {
        ...state,
        queue: state.queue.map((c) =>
          c.id === action.clientId
            ? { ...c, status: 'inProgress' as const, assignedManicuristId: action.manicuristId, startedAt: now, turnValue: turns }
            : c
        ),
        manicurists: state.manicurists.map((m) => {
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
      const newEntries = action.entries.map(({ client, manicuristId }) => {
        if (manicuristId) {
          return { ...client, status: 'inProgress' as const, assignedManicuristId: manicuristId, startedAt: now, turnValue: client.turnValue };
        }
        return client;
      });
      const assignMap = new Map<string, { clientId: string; turns: number; isWax: boolean; is4thPosition: boolean }>();
      for (const { client, manicuristId } of action.entries) {
        if (manicuristId) {
          assignMap.set(manicuristId, {
            clientId: client.id,
            turns: client.turnValue,
            isWax: clientHasAnyWaxService(client.services, state.salonServices),
            is4thPosition: isFourthPositionSpecialService(client.services, state.salonServices),
          });
        }
      }
      return {
        ...state,
        queue: [
          ...state.queue.filter((c) => c.id !== action.originalId),
          ...newEntries,
        ],
        manicurists: state.manicurists.map((m) => {
          const assignment = assignMap.get(m.id);
          if (!assignment) return m;
          const waxSlot   = assignment.isWax ? nextWaxSlot(m)   : null;
          const checkSlot = assignment.is4thPosition ? nextCheckSlot(m) : null;
          return {
            ...m,
            status: 'busy' as const,
            currentClient: assignment.clientId,
            totalTurns: m.totalTurns + assignment.turns,
            ...(checkSlot ? { [checkSlot]: true } : {}),
            ...(waxSlot   ? { [waxSlot]:   true } : {}),
          };
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
            ? { ...m, status: 'available' as const, currentClient: null, totalTurns: Math.max(0, m.totalTurns - turnDeduction), hasFourthPositionSpecial: false }
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
      const completedEntry = {
        id: crypto.randomUUID(),
        clientName: client.clientName,
        services: client.services,
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
      return {
        ...state,
        queue: updatedQueue,
        manicurists: updatedManicurists,
        completed: [...state.completed, completedEntry],
      };
    }

    case 'SET_SELECTED_CLIENT':
      return { ...state, selectedClient: action.clientId };

    case 'SET_EDITING_STAFF':
      return { ...state, editingStaffId: action.staffId };

    case 'CLEAR_HISTORY':
      return { ...state, completed: [] };

    case 'ADD_APPOINTMENT':
      return { ...state, appointments: [...state.appointments, action.appointment] };

    case 'UPDATE_APPOINTMENT':
      return {
        ...state,
        appointments: state.appointments.map((a) =>
          a.id === action.id ? { ...a, ...action.updates } : a
        ),
      };

    case 'DELETE_APPOINTMENT':
      return {
        ...state,
        appointments: state.appointments.filter((a) => a.id !== action.id),
      };

    case 'SET_EDITING_APPOINTMENT':
      return { ...state, editingAppointmentId: action.appointmentId };

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
      const existing = state.dailyHistory.findIndex((d) => d.date === action.entry.date);
      if (existing >= 0) {
        return {
          ...state,
          dailyHistory: state.dailyHistory.map((d) => d.date === action.entry.date ? action.entry : d),
        };
      }
      return { ...state, dailyHistory: [...state.dailyHistory, action.entry] };
    }

    default:
      return state;
  }
}
