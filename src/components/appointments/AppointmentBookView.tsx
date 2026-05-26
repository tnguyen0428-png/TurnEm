import { useRef, useEffect, useState, useCallback, useLayoutEffect, useMemo } from 'react';
import ReceptionistPinGate from '../shared/ReceptionistPinGate';
import { Plus, Trash2, GripVertical, XCircle } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import { formatTimeOfDay, getTodayLA } from '../../utils/time';
import type { Appointment, Manicurist, QueueEntry, ServiceRequest, ServiceType } from '../../types';
import DayScheduleOverrideModal from './DayScheduleOverrideModal';
import { resolveScheduleForDate } from '../../utils/schedule';

const START_HOUR   = 8;
const END_HOUR     = 20;
const SLOT_MINUTES = 15;
const HEADER_H     = 48;
const TIME_COL_W   = 56;

// Min/max bounds when auto-fitting columns and rows to the viewport.
// Bumped up modestly per user request — the previous bounds left the cells
// cramped on typical desktop monitors. Auto-fit still adapts to viewport size;
// these only widen the floor/ceiling so each cell can render a touch larger.
const MIN_COL_WIDTH  = 130;
const MAX_COL_WIDTH  = 260;
const MIN_SLOT_HEIGHT = 26;
const MAX_SLOT_HEIGHT = 72;

const TOTAL_SLOTS = ((END_HOUR - START_HOUR) * 60) / SLOT_MINUTES;

// Pastel palette — one per appointment (consistent across all its service blocks)
const APPT_PALETTES = [
  { bg: '#fce7f3', border: '#f472b6' }, // pink
  { bg: '#ede9fe', border: '#a78bfa' }, // purple
  { bg: '#dbeafe', border: '#60a5fa' }, // blue
  { bg: '#d1fae5', border: '#34d399' }, // green
  { bg: '#fef3c7', border: '#fbbf24' }, // amber
  { bg: '#fee2e2', border: '#f87171' }, // red
  { bg: '#e0f2fe', border: '#38bdf8' }, // sky
  { bg: '#fdf4ff', border: '#e879f9' }, // fuchsia
  { bg: '#f0fdf4', border: '#4ade80' }, // emerald
  { bg: '#fff7ed', border: '#fb923c' }, // orange
];

// Color by client name so all of one client's services share the same color
function apptPalette(appt: Appointment) {
  const key = (appt.clientName || '').trim().toLowerCase() || appt.id;
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return APPT_PALETTES[Math.abs(hash) % APPT_PALETTES.length];
}

function slotToTime(i: number): string {
  const m = START_HOUR * 60 + i * SLOT_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function timeToTopPx(time: string, slotHeight: number): number {
  const [h, m] = time.split(':').map(Number);
  return ((h - START_HOUR) * 60 + m) / SLOT_MINUTES * slotHeight;
}

function hourLabel(i: number): string | null {
  const totalMins = START_HOUR * 60 + i * SLOT_MINUTES;
  const m = totalMins % 60;
  if (m !== 0) return null;
  const h = Math.floor(totalMins / 60);
  if (h === 12) return '12 PM';
  if (h > 12) return `${h - 12} PM`;
  return `${h} AM`;
}

function slotType(i: number): 'hour' | 'half' | 'quarter' {
  const m = (START_HOUR * 60 + i * SLOT_MINUTES) % 60;
  if (m === 0) return 'hour';
  if (m === 30) return 'half';
  return 'quarter';
}

// Local-time weekday from a YYYY-MM-DD string. Avoids the UTC drift you'd get
// from `new Date('2026-04-26').getDay()`.
function weekdayFromYmd(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

function timeToMins(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

interface OffBand {
  top: number;        // px from top of column
  height: number;     // px
  label: string | null;
}

interface ServiceBlock {
  appt: Appointment;
  serviceName: string;
  occurrence: number;    // which instance of this service name (0=first, 1=second...)
  blockTime: string;     // actual HH:MM time this block is positioned at
  duration: number;
  top: number;
  height: number;
  isFirst: boolean;      // first service of this appt in this column
  isApptFirst: boolean;  // very first service of this appt across all columns
  colManicuristId: string | null;
  hasRequest: boolean;
  requestedManicuristId: string | null; // who the client requested (null if no request)
}

interface DragInfo { apptId: string; serviceName: string; occurrence: number }
interface PendingDrop { info: DragInfo; mId: string | null; slot: number }
interface Props { selectedDate: string }

export default function AppointmentBookView({ selectedDate }: Props) {
  const { state, dispatch } = useApp();

  const containerRef = useRef<HTMLDivElement>(null);
  const headerRef    = useRef<HTMLDivElement>(null);
  const bodyRef      = useRef<HTMLDivElement>(null);

  const [cannotParkMsg, setCannotParkMsg] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);

  // Click-to-edit on off-hours overlay: opens DayScheduleOverrideModal for
  // the technician + the specific date that was clicked. Writes a per-date
  // override (staff_schedule_overrides), NOT the recurring blueprint.
  const [editingSchedule, setEditingSchedule] = useState<{ manicuristId: string; weekday: number; date: string } | null>(null);

  // Quick service-duration nudge popup. Receptionists tap a specific
  // service block in an appt once to open this, tap +5 / -5 a few times to
  // shrink or grow ONLY that service's slot height (e.g. shorten a 45-min
  // gel mani to 30 min so it fits between two existing bookings), then tap
  // anywhere else on the appt body (or outside) to commit. This does NOT
  // change appt.time — the appointment still starts at the same minute.
  // The mechanism is a per-(service, occurrence) durationAdjustment delta
  // on appt.serviceRequests, which is the same field the Appointment
  // modal's "+/- m" knob writes to.
  const [nudgePopup, setNudgePopup] = useState<{
    apptId: string;
    serviceName: string;
    occurrence: number;
    /** Resolved base duration with staff timeAdjustment factored in but
     *  without the appt-level durationAdjustment — so the popup can show
     *  the receptionist their delta relative to the salon default for
     *  this (service, staff) pair. */
    baseDuration: number;
    /** Original durationAdjustment on the ServiceRequest at open time;
     *  used to no-op commit when the receptionist makes no change. */
    originalAdjustment: number;
    /** Current draft durationAdjustment the +/- buttons mutate. */
    draftAdjustment: number;
    rect: { top: number; left: number; width: number; height: number };
  } | null>(null);
  // dblclick fires AFTER click on the same target — we hold the click for a
  // short window so a dblclick (which opens the edit modal or unlocks an R
  // appt) cancels the popup before it ever opens. 220ms is below the usual
  // dblclick threshold (~500ms) but above the inter-click interval browsers
  // use, so single-click feels close to instant.
  const apptClickTimerRef = useRef<number | null>(null);

  function nudgeClampAdjustment(base: number, adj: number): number {
    // Effective duration must stay >=5 min (matches svcDuration's floor) and
    // we cap the upper end at +180 so a stray held-down + button doesn't
    // produce a 6-hour block. -base+5 is the lower bound: nothing shorter
    // than 5 minutes total.
    const lowerAdj = -(base - 5);
    const upperAdj = 180;
    return Math.max(lowerAdj, Math.min(upperAdj, adj));
  }

  function commitNudgeNow() {
    const p = nudgePopup;
    if (!p) return;
    setNudgePopup(null);
    if (p.draftAdjustment === p.originalAdjustment) return;
    const appt = state.appointments.find((a) => a.id === p.apptId);
    if (!appt) return;
    const existing = appt.serviceRequests ?? [];
    // Find the specific ServiceRequest entry by (service, occurrence). If
    // none exists, we synthesize one — manicuristIds=[] keeps the implicit
    // routing intact (the renderer falls back to appt.manicuristId for
    // entries with empty manicuristIds), so we change ONLY duration.
    let matchedCount = 0;
    let touched = false;
    const nextRequests = existing.map((r) => {
      if (r.service !== p.serviceName) return r;
      const isTarget = matchedCount === p.occurrence;
      matchedCount += 1;
      if (!isTarget) return r;
      touched = true;
      if (p.draftAdjustment === 0) {
        // Drop the field entirely when back at the default — keeps the
        // ServiceRequest serialized form minimal.
        const next = { ...r };
        delete (next as { durationAdjustment?: number }).durationAdjustment;
        return next;
      }
      return { ...r, durationAdjustment: p.draftAdjustment };
    });
    if (!touched) {
      // No matching ServiceRequest existed for this (service, occurrence).
      // Insert one. clientRequest is intentionally left undefined so we
      // don't false-flag this as a customer-requested manicurist.
      nextRequests.push({
        service: p.serviceName as ServiceType,
        manicuristIds: [],
        durationAdjustment: p.draftAdjustment === 0 ? undefined : p.draftAdjustment,
      });
    }
    dispatch({
      type: 'UPDATE_APPOINTMENT',
      id: appt.id,
      updates: { serviceRequests: nextRequests },
    });
  }

  // Outside-click + Esc: commit on any pointer-down outside the popup AND
  // outside the appt block being nudged. Clicking on the popup's +/- area
  // (data-nudge-popup) skips commit so the buttons can keep working.
  useEffect(() => {
    if (!nudgePopup) return;
    const targetApptId = nudgePopup.apptId;
    const onDown = (e: MouseEvent) => {
      const el = e.target as Element | null;
      if (!el) return;
      if (el.closest('[data-nudge-popup="1"]')) return;
      if (el.closest(`[data-appt-block="${targetApptId}"]`)) return;
      commitNudgeNow();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Esc cancels — discard the draft.
        setNudgePopup(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudgePopup]);

  // Set of appt ids that visually collide with another live appt in the
  // same manicurist column at the exact same start time. Used to paint
  // the small OVERLAP pill. Recomputed only when the appointments list
  // changes (the membership test below is O(1)).
  const collidingApptIds = useMemo(() => {
    const out = new Set<string>();
    const byKey = new Map<string, string[]>();
    for (const a of state.appointments) {
      if (a.status === 'cancelled' || a.status === 'no-show') continue;
      const key = `${a.date}__${a.manicuristId ?? ''}__${a.time}`;
      const list = byKey.get(key) ?? [];
      list.push(a.id);
      byKey.set(key, list);
    }
    for (const list of byKey.values()) {
      if (list.length >= 2) for (const id of list) out.add(id);
    }
    return out;
  }, [state.appointments]);

  // Auto-fit dimensions — initial values used for the very first render before
  // the ResizeObserver in useLayoutEffect computes the real fit.
  const [colWidth, setColWidth]     = useState(130);
  const [slotHeight, setSlotHeight] = useState(40);

  const manicurists = state.manicurists.filter((m) => m.showInBook !== false);
  // build-bust-v1

  // ── Off-hours / vacation visual overlay ───────────────────────────────────
  // For each manicurist column we compute the grey bands to draw based on the
  // staff schedule for the selected weekday, plus any time-off range that
  // covers the date. Visual only — does NOT prevent clicking, dragging, or
  // dropping appointments into greyed cells (per product requirement).
  const offBandsByManicurist = useMemo(() => {
    const map = new Map<string, OffBand[]>();
    const dayStartMin = START_HOUR * 60;
    const dayEndMin = END_HOUR * 60;
    const totalDayMins = dayEndMin - dayStartMin;

    for (const m of manicurists) {
      // Resolver layers time-off > per-date override > weekly blueprint.
      // Tag the OFF band differently when time-off is the reason so the
      // band can still read "TIME OFF" (the override-off case just shows
      // a plain "OFF").
      const inTimeOff = state.staffTimeOff.some(
        (t) => t.manicuristId === m.id && selectedDate >= t.startDate && selectedDate <= t.endDate
      );
      if (inTimeOff) {
        map.set(m.id, [{ top: 0, height: (totalDayMins / SLOT_MINUTES) * slotHeight, label: 'TIME OFF' }]);
        continue;
      }
      const sched = resolveScheduleForDate(
        m.id, selectedDate, state.staffSchedules, state.staffScheduleOverrides, state.staffTimeOff,
      );
      if (!sched) {
        map.set(m.id, [{ top: 0, height: (totalDayMins / SLOT_MINUTES) * slotHeight, label: 'OFF' }]);
        continue;
      }
      const bands: OffBand[] = [];
      const startMin = timeToMins(sched.startTime);
      const endMin = timeToMins(sched.endTime);
      // Before working hours
      if (startMin > dayStartMin) {
        const fromMin = dayStartMin;
        const toMin = Math.min(startMin, dayEndMin);
        if (toMin > fromMin) {
          bands.push({
            top: ((fromMin - dayStartMin) / SLOT_MINUTES) * slotHeight,
            height: ((toMin - fromMin) / SLOT_MINUTES) * slotHeight,
            label: null,
          });
        }
      }
      // After working hours
      if (endMin < dayEndMin) {
        const fromMin = Math.max(endMin, dayStartMin);
        const toMin = dayEndMin;
        if (toMin > fromMin) {
          bands.push({
            top: ((fromMin - dayStartMin) / SLOT_MINUTES) * slotHeight,
            height: ((toMin - fromMin) / SLOT_MINUTES) * slotHeight,
            label: null,
          });
        }
      }
      // Lunch
      if (sched.lunchStart && sched.lunchEnd) {
        const lunchStartMin = timeToMins(sched.lunchStart);
        const lunchEndMin = timeToMins(sched.lunchEnd);
        const fromMin = Math.max(lunchStartMin, dayStartMin);
        const toMin = Math.min(lunchEndMin, dayEndMin);
        if (toMin > fromMin) {
          bands.push({
            top: ((fromMin - dayStartMin) / SLOT_MINUTES) * slotHeight,
            height: ((toMin - fromMin) / SLOT_MINUTES) * slotHeight,
            label: 'LUNCH',
          });
        }
      }
      map.set(m.id, bands);
    }
    return map;
  }, [manicurists, state.staffSchedules, state.staffScheduleOverrides, state.staffTimeOff, selectedDate, slotHeight]);
  const totalGridW  = TIME_COL_W + manicurists.length * colWidth;
  const TOTAL_H     = TOTAL_SLOTS * slotHeight;

  // Appointments now REMAIN visible in the book after being Q'd. We track the
  // linked queue entry by `originalAppointment.id` so we can recolor the block:
  //   - waiting in queue   → light gray
  //   - inProgress         → gray (in service)
  //   - appt.status === 'completed' → black (checked out)
  // This map is built once per render and consumed by the block renderer below.
  const queueByApptId = useMemo(() => {
    const m = new Map<string, QueueEntry>();
    // First pass: direct link via originalAppointment.id. This is the
    // canonical mapping the Q-press flow produces.
    for (const q of state.queue) {
      const aid = q.originalAppointment?.id;
      if (aid) m.set(aid, q);
    }
    // Second pass: soft-match by client name for any of TODAY's appts that
    // still have no entry attached. This catches the case where the appt's
    // status sync to Supabase lagged (block stays scheduled-color even
    // though the client is in service) or the queue entry's
    // originalAppointment link was lost in a split. We only consider
    // top-level entries (no parentQueueId) so a sibling doesn't shadow the
    // real Q'd entry, and we skip the appt id if it's already linked.
    const norm = (s: string | undefined) =>
      (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const byNameToday = new Map<string, QueueEntry>();
    for (const q of state.queue) {
      if (q.parentQueueId) continue;
      const k = norm(q.clientName);
      if (k && !byNameToday.has(k)) byNameToday.set(k, q);
    }
    for (const a of state.appointments) {
      if (a.date !== selectedDate) continue;
      if (m.has(a.id)) continue;
      const k = norm(a.clientName);
      const hit = k ? byNameToday.get(k) : undefined;
      if (hit) m.set(a.id, hit);
    }
    return m;
  }, [state.queue, state.appointments, selectedDate]);

  // Appointment ids that have a completed_services row attached but the
  // register ticket hasn't been closed yet. Per user request 2026-05-22, these
  // stay in the in-service light-gray state until payment is processed; only
  // then does COMPLETE_SERVICE's sibling — TicketModal.handleProcess — flip
  // the appt status to 'completed' (dark gray).
  //
  // Match by lowercase client name across today's completed_services rows and
  // today's appts. The originalAppointmentId field is in-memory only (the DB
  // table has no such column), so it disappears on every page refresh. Without
  // a name-based fallback the block goes back to its "checked-in green"
  // palette right after refresh, which is what you saw with Sarah/Joney/Danny.
  const awaitingPaymentApptIds = useMemo(() => {
    const ids = new Set<string>();
    // "Awaiting payment" means the client's service from TODAY hasn't had its
    // ticket closed yet. Only today's appts can be in that state — a future
    // appt booked from the checkout flow for a just-completed client must NOT
    // inherit the light-gray awaiting-payment color. (Bug 2026-05-25: future
    // appts created via BOOK APPT from the ticket modal rendered gray because
    // the name-match fallback below didn't gate on today's date.)
    const todayKey = getTodayLA();
    if (selectedDate !== todayKey) return ids;
    const norm = (v: string | undefined) =>
      (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    // 1) Direct id link — covers the same-session case before refresh.
    //    Still gated to today's appts only: the originalAppointmentId could
    //    in principle point at a non-today appt (it never does today, but
    //    we don't want to start coloring future blocks if that ever changes).
    const todayApptIds = new Set<string>();
    for (const a of state.appointments) {
      if (a.date === todayKey) todayApptIds.add(a.id);
    }
    for (const c of state.completed) {
      if (c.voided) continue;
      if (c.originalAppointmentId && todayApptIds.has(c.originalAppointmentId)) {
        ids.add(c.originalAppointmentId);
      }
    }
    // 2) Refresh-safe fallback: name-match today's completed entries to today's
    //    appts. Only count an appt as awaiting payment if it isn't already
    //    'completed' (ticket closed) and the client doesn't have a live queue
    //    entry (which would render in-service / waiting-Q instead).
    const completedNamesToday = new Set<string>();
    for (const c of state.completed) {
      if (c.voided) continue;
      const k = norm(c.clientName);
      if (k) completedNamesToday.add(k);
    }
    for (const a of state.appointments) {
      if (a.date !== todayKey) continue;
      if (a.status === 'completed' || a.status === 'cancelled' || a.status === 'no-show') continue;
      const k = norm(a.clientName);
      if (k && completedNamesToday.has(k)) ids.add(a.id);
    }
    return ids;
  }, [state.completed, state.appointments, selectedDate]);
  const dayAppts = state.appointments.filter(
    (a) =>
      a.date === selectedDate &&
      a.status !== 'cancelled' &&
      a.status !== 'no-show'
  );

  // Per-column busy intervals for the visible day, used by Same-Time fan-out
  // to skip columns that already have an appointment running at the target
  // time. Without this, a candidate column whose previous appointment runs
  // late into the target slot (e.g. Kimberly's 8:45 Gel Fill bleeding into
  // 9:00) would be picked, stacking the new block on top of the existing one.
  // We rebuild this per render — cost is low (dayAppts is one day's worth)
  // and recomputing keeps it consistent with any UI edits.
  const occupancyByColumn = useMemo(() => {
    const map = new Map<string, Array<{ apptId: string; startMin: number; endMin: number }>>();
    function pushBusy(manId: string, apptId: string, startMin: number, endMin: number) {
      const arr = map.get(manId) ?? [];
      arr.push({ apptId, startMin, endMin });
      map.set(manId, arr);
    }
    function durFor(svcName: string, manId: string | null, apptAdj?: number): number {
      const base = state.salonServices.find((s) => s.name === svcName)?.duration ?? 60;
      const staffAdj = manId
        ? ((state.manicurists.find((mm) => mm.id === manId)?.timeAdjustments?.[svcName]) || 0)
        : 0;
      return Math.max(base + staffAdj + (apptAdj || 0), 5);
    }
    for (const a of dayAppts) {
      const svcs = (a.services?.length ? a.services : [a.service as string]).filter(Boolean);
      const allReqs = a.serviceRequests || [];
      const [sh, sm] = a.time.split(':').map(Number);
      const apptStartMin = sh * 60 + sm;
      let elapsed = 0;
      const occCount: Record<string, number> = {};
      for (let i = 0; i < svcs.length; i++) {
        const svcName = svcs[i];
        const occ = occCount[svcName] ?? 0;
        occCount[svcName] = occ + 1;
        const reqsForSvc = allReqs.filter((r) => r.service === svcName);
        const req = reqsForSvc[occ] ?? null;
        const manId = (req && req.manicuristIds.length > 0)
          ? req.manicuristIds[0]
          : (a.manicuristId ?? null);
        const dur = durFor(svcName, manId, req?.durationAdjustment);
        let startMin: number;
        if (req?.startTime) {
          const [h, m] = req.startTime.split(':').map(Number);
          startMin = h * 60 + m;
        } else if (a.sameTime) {
          startMin = apptStartMin;
        } else {
          startMin = apptStartMin + elapsed;
        }
        if (manId) pushBusy(manId, a.id, startMin, startMin + dur);
        if (!a.sameTime) elapsed += dur;
      }
    }
    return map;
  }, [dayAppts, state.salonServices, state.manicurists]);

  // True if column `manId` already has another appointment overlapping the
  // half-open interval [startMin, endMin) — i.e. a real time conflict, not
  // just a same-start-time check.
  function columnBusyInRange(manId: string, startMin: number, endMin: number, excludeApptId: string): boolean {
    const arr = occupancyByColumn.get(manId) ?? [];
    return arr.some((iv) => iv.apptId !== excludeApptId && iv.startMin < endMin && iv.endMin > startMin);
  }

  // True when this manicurist isn't working on the selected date for the
  // given time window — either on a time-off range, no schedule for this
  // weekday (= recurring day off), or the window falls outside their
  // working hours / inside their lunch break. Used so the same-time
  // fan-out below skips columns the tech doesn't actually work, which
  // is why a 3-pedicure unassigned appointment used to render one block
  // into Tommy's column on a Monday even though he's off.
  function columnIsOffOnDate(manId: string, startMin: number, endMin: number): boolean {
    const sched = resolveScheduleForDate(
      manId, selectedDate, state.staffSchedules, state.staffScheduleOverrides, state.staffTimeOff,
    );
    if (!sched) return true;
    const schedStart = timeToMins(sched.startTime);
    const schedEnd = timeToMins(sched.endTime);
    if (startMin < schedStart || endMin > schedEnd) return true;
    if (sched.lunchStart && sched.lunchEnd) {
      const lStart = timeToMins(sched.lunchStart);
      const lEnd = timeToMins(sched.lunchEnd);
      if (startMin < lEnd && endMin > lStart) return true;
    }
    return false;
  }

  // ── Auto-fit columns + slots to viewport ────────────────────────────────
  useLayoutEffect(() => {
    if (!containerRef.current) return;

    const recalc = () => {
      const el = containerRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return;

      const n = Math.max(1, manicurists.length);
      // Horizontal: divide remaining width evenly across manicurist columns
      const fitColW = Math.floor((w - TIME_COL_W) / n);
      const newColW = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, fitColW));
      // Vertical: divide remaining height across all 15-minute slots
      const fitSlotH = Math.floor((h - HEADER_H) / TOTAL_SLOTS);
      const newSlotH = Math.max(MIN_SLOT_HEIGHT, Math.min(MAX_SLOT_HEIGHT, fitSlotH));

      setColWidth((c) => (c !== newColW ? newColW : c));
      setSlotHeight((s) => (s !== newSlotH ? newSlotH : s));
    };

    recalc();
    const ro = new ResizeObserver(recalc);
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [manicurists.length]);

  // ── Sync horizontal scroll between header and body ──────────────────────
  const onBodyScroll = useCallback(() => {
    if (headerRef.current && bodyRef.current) {
      headerRef.current.scrollLeft = bodyRef.current.scrollLeft;
    }
  }, []);
  const onHeaderScroll = useCallback(() => {
    if (headerRef.current && bodyRef.current) {
      bodyRef.current.scrollLeft = headerRef.current.scrollLeft;
    }
  }, []);

  // ── Service-block drag/drop state ────────────────────────────────────────
  const [dragInfo, setDragInfo]         = useState<DragInfo | null>(null);
  const [dropTarget, setDropTarget]     = useState<{ mId: string | null; slot: number } | null>(null);
  // Receptionist double-clicked a REQUEST appt (R badge) to temporarily
  // unlock it for a one-time move. While the id matches, the block is
  // draggable and the R badge pulses. executeDrop clears this back to
  // null so the appt re-locks immediately after the drop. Other appts
  // (non-R, or different id) still follow the standard isLocked rules.
  const [movableRequestApptId, setMovableRequestApptId] = useState<string | null>(null);

  // Safety net: if a drag never finishes (dropped outside, Escape, etc.),
  // clear dragInfo on any document-level dragend or mouseup. Without this,
  // dragInfo can get stuck non-null which puts pointer-events: none on every
  // block — making all action buttons (delete/cancel/edit/Q) unclickable.
  useEffect(() => {
    function clearDrag() {
      setDragInfo(null);
      setDropTarget(null);
    }
    document.addEventListener('dragend', clearDrag);
    document.addEventListener('drop', clearDrag);
    return () => {
      document.removeEventListener('dragend', clearDrag);
      document.removeEventListener('drop', clearDrag);
    };
  }, []);

  // ── Column-reorder drag/drop state ───────────────────────────────────────
  const [colDragId, setColDragId]         = useState<string | null>(null);
  const [colDropTargetId, setColDropTargetId] = useState<string | null>(null);

  // ── Services popover: double-clicking a manicurist's column header opens
  //    a small panel below the header listing the services that manicurist
  //    can perform (from their `skills` array). Tap anywhere or pick another
  //    header to dismiss. Stored as the manicurist id, or null when closed.
  //
  // We use manual two-mousedown detection (timestamp + last id) instead of
  // the native `dblclick` event because the column header is also
  // draggable=true for reorder. Browsers often swallow `dblclick` on
  // draggable elements when the first mousedown initiates a drag-tracking
  // state. mousedown fires reliably regardless, so we count two of them
  // within ~350ms on the same header as a "double click".
  // Track which manicurist's popover is open AND its screen-space anchor
  // so the popover can render as position:fixed and escape the header's
  // `overflow-hidden` clipping. Anchor is captured at click time from the
  // header column's bounding rect.
  const [servicesPopover, setServicesPopover] = useState<{ id: string; left: number; top: number } | null>(null);
  useEffect(() => {
    if (!servicesPopover) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && target.closest('[data-services-popover]')) return;
      if (target && target.closest('[data-services-header]')) return;
      setServicesPopover(null);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setServicesPopover(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [servicesPopover]);

  // ── Left-click drag-to-pan state (hold left mouse button on empty calendar
  //    space and drag to swipe the view around) ─────────────────────────────
  // Pan is initiated only when the mousedown target is NOT inside an
  // appointment block — appointment blocks are draggable=true and reserved
  // for HTML5 drag-and-drop (moving the appointment to a different slot or
  // column). On empty slots we track movement; if the user moves more than
  // a small threshold we enter pan mode and start scrolling. If they release
  // without moving, the original click handler still runs (opens the Add
  // modal). Once pan-moved is set, we swallow the upcoming click so empty
  // slot clicks don't accidentally open the modal at the end of a pan.
  const panRef = useRef<{ active: boolean; panning: boolean; startX: number; startY: number; startScrollLeft: number; startScrollTop: number; moved: boolean }>({
    active: false, panning: false, startX: 0, startY: 0, startScrollLeft: 0, startScrollTop: 0, moved: false,
  });
  const [isPanning, setIsPanning] = useState(false);

  // Attach mousedown as a native CAPTURE-phase listener directly on the body
  // so we see the left-click before any descendant can call stopPropagation
  // in the bubble phase.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const handleDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // left click only
      // Don't intercept clicks on appointment blocks — those are draggable
      // (HTML5 dnd) and clickable for opening the edit modal.
      const target = e.target as Element | null;
      if (target && target.closest('[draggable="true"]')) return;
      // Don't intercept clicks on the time-of-day column or other interactive
      // controls inside the body (buttons, inputs, etc.) so they keep working.
      if (target && target.closest('button, input, select, textarea, a')) return;
      panRef.current = {
        active: true,
        panning: false,
        startX: e.clientX,
        startY: e.clientY,
        startScrollLeft: body.scrollLeft,
        startScrollTop: body.scrollTop,
        moved: false,
      };
    };
    body.addEventListener('mousedown', handleDown, { capture: true });
    return () => body.removeEventListener('mousedown', handleDown, { capture: true } as any);
  }, []);

  // Window-level move/up listeners run for the lifetime of the component so
  // we can detect drags that begin on the body but cross out of it.
  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (!panRef.current.active || !bodyRef.current) return;
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      // Cross movement threshold — promote tracked press into a real pan.
      if (!panRef.current.panning && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        panRef.current.panning = true;
        panRef.current.moved = true;
        setIsPanning(true);
      }
      if (panRef.current.panning) {
        e.preventDefault();
        bodyRef.current.scrollLeft = panRef.current.startScrollLeft - dx;
        bodyRef.current.scrollTop = panRef.current.startScrollTop - dy;
      }
    };
    const handleUp = () => {
      if (!panRef.current.active) return;
      const wasPanning = panRef.current.panning;
      panRef.current.active = false;
      panRef.current.panning = false;
      if (wasPanning) {
        setIsPanning(false);
        // Suppress the click that would otherwise fire after this mouseup
        // (e.g. opening the Add modal on the slot we ended on).
        const swallow = (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
          window.removeEventListener('click', swallow, true);
        };
        window.addEventListener('click', swallow, true);
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  // Service duration accounting for both the assigned staff's per-service
  // time adjustment (Staff Management → "+/- m" knob) AND any per-appointment
  // adjustment captured on the ServiceRequest (Appointment Modal → "+/- m"
  // knob). Stacks both. Falls back to the base service duration when no
  // manicurist is assigned. Always clamped to at least 5 minutes so block
  // heights and overlap math stay sane.
  function svcDuration(
    name: string,
    manicuristId?: string | null,
    apptAdjustment?: number,
  ): number {
    const base = state.salonServices.find((s) => s.name === name)?.duration ?? 60;
    const staffAdj = manicuristId
      ? ((state.manicurists.find((mm) => mm.id === manicuristId)?.timeAdjustments?.[name]) || 0)
      : 0;
    const apptAdj = apptAdjustment || 0;
    return Math.max(base + staffAdj + apptAdj, 5);
  }

  function getApptSvcs(appt: Appointment): string[] {
    return (appt.services?.length ? appt.services : [appt.service as string]).filter(Boolean);
  }

  function getServiceBlocks(mId: string | null): ServiceBlock[] {
    const blocks: ServiceBlock[] = [];

    for (const appt of dayAppts) {
      const svcs = getApptSvcs(appt);
      const allReqs = appt.serviceRequests || [];
      const [startH, startM] = appt.time.split(':').map(Number);

      const occurrenceCount: Record<string, number> = {};
      // Track total elapsed minutes across ALL services in this appointment,
      // regardless of which manicurist's column they end up in. That way a
      // pedi requested with Tammy auto-shifts to start when the fill with
      // Sam ends, instead of overlapping it at 10:00.
      let elapsedMins = 0;
      let isFirst = true;

      // When "Same time" is checked on the appointment, multi-service bookings
      // should fan out across DIFFERENT staff columns at the same start time
      // instead of stacking under one manicurist 45 minutes apart. We track
      // which columns are already taken by earlier services on this appt so
      // each new no-request service picks the next available skilled column.
      const usedColumnIds = new Set<string>();

      // Per-column elapsed minutes for Same Time bookings. Two services sent
      // to the SAME column inside a Same Time appointment should still stack
      // sequentially (4:00 + 4:30) instead of overlapping at 4:00. This map
      // tracks how many minutes are already booked in each column by earlier
      // services in this same appointment.
      const columnElapsedMap = new Map<string, number>();

      for (let i = 0; i < svcs.length; i++) {
        const svcName = svcs[i];
        const occ = occurrenceCount[svcName] ?? 0;
        occurrenceCount[svcName] = occ + 1;

        const reqsForSvc = allReqs.filter((r) => r.service === svcName);
        const req = reqsForSvc[occ] ?? null;

        let assignedMId: string | null;
        if (req && req.manicuristIds.length > 0) {
          assignedMId = req.manicuristIds[0];
        } else if (req && req.manicuristIds.length === 0) {
          assignedMId = null;
        } else {
          // No per-service request — try the appointment's primary column
          // first. If that manicurist can't do this service (skill mismatch),
          // route the block to the first visible-in-book manicurist who can.
          // This prevents a "gel pedi" added to a fill-with-Sam booking from
          // silently disappearing because Sam doesn't do pedicures.
          //
          // Same-time fan-out: if appt.sameTime is on AND the appointment's
          // primary column is already taken by an earlier service in this
          // appt, route this service to the next available skilled column.
          // That turns "Emma at 9am for 2 pedicures with Same time" into
          // "Tommy 9am + next skilled tech 9am" instead of "Tommy 9am + Tommy
          // 9:45am".
          const fallbackMId = appt.manicuristId ?? null;
          const colMani = fallbackMId ? state.manicurists.find((m) => m.id === fallbackMId) : null;
          const colManiHasSkill = !colMani || colMani.skills.length === 0 || colMani.skills.includes(svcName);
          // Compute the target time window this service needs in a column.
          // For Same Time bookings every service starts at appt.time; otherwise
          // it stacks after previously-placed services in this appt.
          const apptStartMin = startH * 60 + startM;
          const tentativeStartMin = appt.sameTime ? apptStartMin : apptStartMin + elapsedMins;
          // We don't know the staff yet, so use the booking's primary for the
          // duration estimate — good enough for the conflict check.
          const tentativeDur = svcDuration(svcName, fallbackMId, req?.durationAdjustment);
          const tentativeEndMin = tentativeStartMin + tentativeDur;

          const primaryAvailable = colManiHasSkill && fallbackMId
            && !(appt.sameTime && usedColumnIds.has(fallbackMId))
            && !(appt.sameTime && columnBusyInRange(fallbackMId, tentativeStartMin, tentativeEndMin, appt.id));
          if (primaryAvailable) {
            assignedMId = fallbackMId;
          } else {
            // Same Time fan-out: prefer a skilled column not used by this
            // appt AND whose existing schedule doesn't overlap the target
            // time window (full duration-aware check).
            const freeAndSkilled = manicurists.find(
              (m) =>
                (m.skills.length === 0 || m.skills.includes(svcName)) &&
                !usedColumnIds.has(m.id) &&
                !columnIsOffOnDate(m.id, tentativeStartMin, tentativeEndMin) &&
                !columnBusyInRange(m.id, tentativeStartMin, tentativeEndMin, appt.id)
            );
            if (freeAndSkilled) {
              assignedMId = freeAndSkilled.id;
            } else {
              // No free column for the requested service — best-effort
              // fallback so the block is still visible. Still avoid
              // off-schedule techs so we don't quietly land work on a
              // day they're not in.
              const skilledColMani = manicurists.find(
                (m) =>
                  (m.skills.length === 0 || m.skills.includes(svcName)) &&
                  !usedColumnIds.has(m.id) &&
                  !columnIsOffOnDate(m.id, tentativeStartMin, tentativeEndMin)
              );
              assignedMId = skilledColMani?.id ?? fallbackMId ?? null;
            }
          }
        }

        if (assignedMId) usedColumnIds.add(assignedMId);

        // Pass the assigned manicurist plus any per-appointment adjustment
        // so the block height (and the running elapsedMins used for stacking
        // the next service) reflects both staff- and booking-level tweaks.
        const dur = svcDuration(svcName, assignedMId, req?.durationAdjustment);

        if (assignedMId === mId) {
          let blockTopPx: number;
          let blockTime: string;
          if (req?.startTime) {
            blockTopPx = timeToTopPx(req.startTime, slotHeight);
            blockTime  = req.startTime;
          } else if (appt.sameTime) {
            // Same Time: each column independently stacks its services from
            // appt.time. So if both Gel Polish Hand and Polish Change Feet
            // are requested for Panda, Hand starts at 4:00 and Feet starts
            // at 4:30. Services routed to different columns all start at
            // 4:00 — the "same time" promise holds across the appointment
            // but doesn't force same-time overlap inside one column.
            const colElapsed = assignedMId ? (columnElapsedMap.get(assignedMId) ?? 0) : 0;
            const startMins = (startH - START_HOUR) * 60 + startM + colElapsed;
            blockTopPx = startMins / SLOT_MINUTES * slotHeight;
            const totalMins = startH * 60 + startM + colElapsed;
            blockTime = `${String(Math.floor(totalMins / 60)).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}`;
          } else {
            const startMins = (startH - START_HOUR) * 60 + startM + elapsedMins;
            blockTopPx = startMins / SLOT_MINUTES * slotHeight;
            const totalMins = startH * 60 + startM + elapsedMins;
            blockTime = `${String(Math.floor(totalMins / 60)).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}`;
          }

          const height     = Math.max(dur / SLOT_MINUTES * slotHeight - 3, 20);
          const isApptFirst = isFirst && i === 0;
          const hasRequest  = !!(req && req.manicuristIds.length > 0 && req.clientRequest === true);
          const requestedManicuristId = hasRequest ? (req!.manicuristIds[0] ?? null) : null;

          blocks.push({ appt, serviceName: svcName, occurrence: occ, blockTime, duration: dur,
            top: blockTopPx, height, isFirst, isApptFirst, colManicuristId: mId,
            hasRequest, requestedManicuristId });
          isFirst = false;
        }

        // Always advance elapsed time across all services in the appointment,
        // even if this one is rendered in a different column (or skipped here).
        // That keeps later services stacked after earlier ones regardless of
        // which manicurist each lands on.
        elapsedMins += dur;
        if (appt.sameTime && assignedMId) {
          const prev = columnElapsedMap.get(assignedMId) ?? 0;
          columnElapsedMap.set(assignedMId, prev + dur);
        }
      }
    }
    return blocks;
  }

  function removeSvcFromAppt(appt: Appointment, svcName: string) {
    const all = getApptSvcs(appt);
    const firstIdx = all.indexOf(svcName);
    const svcs = firstIdx >= 0 ? [...all.slice(0, firstIdx), ...all.slice(firstIdx + 1)] : all;
    if (svcs.length === 0) {
      dispatch({ type: 'DELETE_APPOINTMENT', id: appt.id });
    } else {
      const newReqs = (appt.serviceRequests || []).filter((r) => r.service !== svcName);
      dispatch({ type: 'UPDATE_APPOINTMENT', id: appt.id, updates: {
        services: svcs, service: svcs[0] as ServiceType,
        serviceRequests: newReqs,
        manicuristId: newReqs[0]?.manicuristIds?.[0] ?? appt.manicuristId ?? null,
      }});
    }
  }

  function deleteSvcBlock(e: React.MouseEvent, appt: Appointment, svcName: string) {
    e.stopPropagation();
    removeSvcFromAppt(appt, svcName);
  }

  function addApptToQueue(e: React.MouseEvent, appt: Appointment) {
    e.stopPropagation();
    // Keep the appointment in the book; flag it as 'checked-in' so the block
    // renderer can recolor it (light gray while waiting, gray while in service,
    // black after checkout). The Revert button on the queue card flips this
    // back to 'scheduled'.
    dispatch({ type: 'UPDATE_APPOINTMENT', id: appt.id, updates: { status: 'checked-in' } });
    const services = getApptSvcs(appt) as ServiceType[];
    // CRITICAL: only ServiceRequests with clientRequest === true represent an actual
    // request from the customer. Anything else is just a salon-placed parking slot in
    // the calendar column (e.g. dragged into Brian's column for visual scheduling) and
    // must NOT be carried into the queue as a request — assignment for those is
    // determined when the customer arrives. We strip manicuristIds from non-request
    // entries so downstream queue/turn logic doesn't treat them as requests.
    const rawRequests = appt.serviceRequests || [];
    const serviceRequests: ServiceRequest[] = rawRequests.map((r) =>
      r.clientRequest === true ? r : { ...r, manicuristIds: [] }
    );
    const isRequested      = serviceRequests.some((r) => r.clientRequest === true && r.manicuristIds.length > 0);
    const firstRequestedId = serviceRequests.find((r) => r.clientRequest === true)?.manicuristIds?.[0] ?? null;
    const turnValue = services.reduce((sum, svc) => {
      const s = state.salonServices.find((ss) => ss.name === svc);
      const base = s?.turnValue ?? SERVICE_TURN_VALUES[svc] ?? 1;
      const hasReq = serviceRequests.some((r) => r.service === svc && r.clientRequest === true && r.manicuristIds.length > 0);
      return sum + (hasReq && base > 0 ? (s?.category === 'Combo' ? 1 : 0.5) : base);
    }, 0);
    dispatch({ type: 'ADD_CLIENT', client: {
      id: crypto.randomUUID(), clientName: appt.clientName || 'Walk-in',
      services, turnValue, serviceRequests, requestedManicuristId: firstRequestedId,
      isRequested, isAppointment: true, assignedManicuristId: null, status: 'waiting',
      arrivedAt: Date.now(), startedAt: null, completedAt: null, extraTimeMs: 0,
      // Snapshot the original appointment so the Revert button on the queue card
      // can restore it back into its exact slot (date, time, column, per-service
      // placements). The snapshot keeps the original serviceRequests with their
      // manicuristIds intact — distinct from the queue's `serviceRequests` above
      // which has parked-column manicuristIds cleared so the queue doesn't see
      // them as requests.
      originalAppointment: appt,
    } as QueueEntry });
  }

  function executeDrop(info: DragInfo, mId: string | null, slot: number) {
    const { apptId, serviceName, occurrence } = info;
    const appt = state.appointments.find((a) => a.id === apptId);
    if (!appt) return;
    const newTime = slotToTime(slot);
    const allReqs = appt.serviceRequests || [];

    const reqsForSvc = allReqs.filter((r) => r.service === serviceName);
    const currentReq = reqsForSvc[occurrence] ?? null;
    const allIdxsForSvc = allReqs.reduce<number[]>((acc, r, i) => {
      if (r.service === serviceName) acc.push(i);
      return acc;
    }, []);
    const targetIdx = allIdxsForSvc[occurrence];

    const isFirstService = occurrence === 0 && serviceName === appt.services?.[0];

    const newEntry = {
      service: serviceName as ServiceType,
      manicuristIds: mId ? [mId] : (currentReq?.manicuristIds ?? []),
      clientRequest: (currentReq?.clientRequest ?? false) as boolean,
      startTime: newTime,
    };

    let updatedReqs = [...allReqs];
    if (targetIdx !== undefined) {
      updatedReqs = updatedReqs.map((r, i) => i === targetIdx ? newEntry : r);
    } else {
      updatedReqs = [...updatedReqs, newEntry];
    }

    const updates: Partial<typeof appt> = { serviceRequests: updatedReqs };
    if (isFirstService) updates.time = newTime;
    // Receptionist confirmed the walk-in's placement by dragging it. Clear
    // the isWalkIn flag so the flashing W badge + amber tint goes away.
    if (appt.isWalkIn) updates.isWalkIn = false;

    dispatch({ type: 'UPDATE_APPOINTMENT', id: apptId, updates });
    // A requested appt was just moved via the double-click unlock — re-lock
    // it so the next interaction goes back to the normal "edit modal only"
    // path. Done last so any UPDATE_APPOINTMENT side effects have already
    // queued.
    if (movableRequestApptId === apptId) setMovableRequestApptId(null);

    // Turn credit follow-through. If this appt is in the "awaiting payment"
    // state (service done, ticket still open), the turn was already credited
    // to the previous tech via completed_services. Repoint that row to the new
    // tech using UPDATE_COMPLETED, which the reducer special-cases to subtract
    // from the old manicurist's totalTurns and add to the new one's. Without
    // this, dragging Joney from JOE's column to TAMMY's column visually moves
    // the block but JOE keeps the turn credit. Per user request 2026-05-22.
    if (!mId) return;
    if (mId === (currentReq?.manicuristIds?.[0] ?? appt.manicuristId)) return;
    const newMani = state.manicurists.find((m) => m.id === mId);
    if (!newMani) return;
    const norm = (v: string | undefined) =>
      (v ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const apptName = norm(appt.clientName);
    const matchingCompleted = state.completed.filter(
      (c) => !c.voided && norm(c.clientName) === apptName && c.services?.includes(serviceName as ServiceType),
    );
    // Prefer the row currently owned by a tech that's NOT the destination.
    const completedToMove = matchingCompleted.find((c) => c.manicuristId !== mId) ?? matchingCompleted[0];
    if (!completedToMove) return;
    dispatch({
      type: 'UPDATE_COMPLETED',
      id: completedToMove.id,
      updates: {
        manicuristId: mId,
        manicuristName: newMani.name,
        manicuristColor: newMani.color,
      },
    });
  }

  function onDragStart(e: React.DragEvent, appt: Appointment, svcName: string, occurrence: number) {
    e.stopPropagation();
    const info: DragInfo = { apptId: appt.id, serviceName: svcName, occurrence };
    setDragInfo(info);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(info));
  }

  function onSlotDragOver(e: React.DragEvent, mId: string | null, slot: number) {
    if (!dragInfo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ mId, slot });
  }

  function onSlotDrop(e: React.DragEvent, mId: string | null, slot: number) {
    e.preventDefault();
    let info: DragInfo | null = null;
    try { info = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { info = dragInfo; }
    if (!info) return;
    setDragInfo(null);
    setDropTarget(null);

    if (mId !== null) {
      const colMani = state.manicurists.find((m) => m.id === mId);
      if (colMani && colMani.skills.length > 0 && !colMani.skills.includes(info.serviceName)) {
        setCannotParkMsg(`${colMani.name} does not do ${info.serviceName}`);
        setTimeout(() => setCannotParkMsg(null), 3000);
        return;
      }
    }

    // No-overlap check: dropping here would span [slot, slot+span). Use the
    // destination column's staff time adjustment AND the dragged service's
    // per-appointment adjustment so a block that would actually take longer
    // doesn't get a too-short overlap window (and silently clobber the next).
    const draggedAppt = state.appointments.find((a) => a.id === info.apptId);
    const draggedReqs = (draggedAppt?.serviceRequests || []).filter((r) => r.service === info.serviceName);
    const draggedReq = draggedReqs[info.occurrence] ?? null;
    const dur = svcDuration(info.serviceName, mId, draggedReq?.durationAdjustment);
    const span = Math.max(1, Math.ceil(dur / SLOT_MINUTES));
    const dropStart = slot;
    const dropEnd   = slot + span;
    // Exclude every block from the same appointment from the overlap check —
    // otherwise you can't rearrange services within a multi-service appointment.
    const others = getServiceBlocks(mId).filter((b) => b.appt.id !== info!.apptId);
    const slotPx = slotHeight; // current slot height
    const overlap = others.find((b) => {
      const bStart = Math.round(b.top / slotPx);
      const bEnd   = bStart + Math.max(1, Math.round(b.height / slotPx));
      return bStart < dropEnd && bEnd > dropStart;
    });
    if (overlap) {
      setCannotParkMsg(`slot is occupied by ${overlap.appt.clientName || 'another appointment'}`);
      setTimeout(() => setCannotParkMsg(null), 3000);
      return;
    }

    executeDrop(info!, mId, slot);
  }

  function onDragEnd() { setDragInfo(null); setDropTarget(null); }

  // ── Column reorder drag handlers ────────────────────────────────────────
  function onColDragStart(e: React.DragEvent, mId: string) {
    e.stopPropagation();
    setColDragId(mId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('application/x-column-reorder', mId);
  }
  function onColDragOver(e: React.DragEvent, mId: string) {
    if (!colDragId || colDragId === mId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setColDropTargetId(mId);
  }
  function onColDrop(e: React.DragEvent, mId: string) {
    if (!colDragId || colDragId === mId) return;
    e.preventDefault();
    e.stopPropagation();
    // Reorder full manicurist list (preserve hidden ones in original order)
    const fullIds = state.manicurists.map((m) => m.id);
    const fromIdx = fullIds.indexOf(colDragId);
    const toIdx   = fullIds.indexOf(mId);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = [...fullIds];
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, colDragId);
    dispatch({ type: 'SET_MANICURIST_ORDER', ids: next });
    setColDragId(null);
    setColDropTargetId(null);
  }
  function onColDragEnd() { setColDragId(null); setColDropTargetId(null); }

  // ── Current time indicator ──────────────────────────────────────────────
  const todayKey = new Date().toISOString().split('T')[0];
  const isToday  = selectedDate === todayKey;
  const now      = new Date();
  const nowMins  = isToday ? (now.getHours() - START_HOUR) * 60 + now.getMinutes() : null;
  const nowTopPx = nowMins !== null && nowMins >= 0 && nowMins <= (END_HOUR - START_HOUR) * 60
    ? nowMins / SLOT_MINUTES * slotHeight : null;

  useEffect(() => {
    if (bodyRef.current)
      bodyRef.current.scrollTop = nowTopPx != null ? Math.max(0, nowTopPx - 120) : 0;
  }, [selectedDate]); // eslint-disable-line

  // Pending open: receptionist double-clicked either an empty slot (kind='add')
  // or an existing appt block (kind='edit'). We hold the draft parameters
  // here until they pass the PIN gate. The actual modal-open happens in
  // onConfirm so the audit trail starts at the receptionist taking control,
  // not at save time.
  type PendingOpen =
    | { kind: 'add'; mId: string | null; slotIdx: number }
    | { kind: 'edit'; appt: Appointment };
  const [pendingOpen, setPendingOpen] = useState<PendingOpen | null>(null);

  function openAddModal(mId: string | null, slotIdx: number) {
    setPendingOpen({ kind: 'add', mId, slotIdx });
  }

  function commitOpenModal(receptionistId: string) {
    if (!pendingOpen) return;
    if (pendingOpen.kind === 'add') {
      const { mId, slotIdx } = pendingOpen;
      dispatch({
        type: 'SET_APPOINTMENT_DRAFT',
        draft: {
          date: selectedDate,
          time: slotToTime(slotIdx),
          manicuristId: mId,
          bookedByReceptionistId: receptionistId,
        },
      });
      dispatch({ type: 'SET_MODAL', modal: 'addAppointment' });
    } else {
      // Edit: stash the receptionist id on the draft so the modal can
      // stamp it onto lastEditedByReceptionistId at save.
      dispatch({
        type: 'SET_APPOINTMENT_DRAFT',
        draft: { editingReceptionistId: receptionistId },
      });
      dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: pendingOpen.appt.id });
      dispatch({ type: 'SET_MODAL', modal: 'editAppointment' });
    }
    setPendingOpen(null);
  }

  function openEditModalGated(appt: Appointment) {
    setPendingOpen({ kind: 'edit', appt });
  }

  function renderColumn(m: Manicurist | null) {
    const mId    = m ? m.id : null;
    const rawBlocks = getServiceBlocks(mId);
    // Sort blocks by top ascending so when two blocks in the same column overlap
    // in time, the earlier-starting block renders FIRST (lower DOM order) and the
    // later block stacks on top. The earlier block's name strip (its top portion)
    // remains visible above the overlap line — e.g. Sam's two near-same-time appts.
    // Tie-break by height descending so a longer block sits behind a shorter one
    // that starts at the same minute.
    const blocks = [...rawBlocks].sort((a, b) => a.top - b.top || b.height - a.height);
    return (
      <div key={mId ?? 'any'} className="flex-shrink-0 relative border-r border-gray-200"
        style={{ width: colWidth, height: TOTAL_H }}
        onDragLeave={() => setDropTarget(null)}>

        {Array.from({ length: TOTAL_SLOTS }).map((_, i) => {
          const type     = slotType(i);
          const isHour   = type === 'hour';
          const isDropOver = dropTarget?.mId === mId && dropTarget?.slot === i && !!dragInfo;
          return (
            <div key={i}
              className={`absolute left-0 right-0 cursor-pointer group transition-colors ${isDropOver ? 'bg-pink-100 ring-1 ring-pink-400 ring-inset' : 'hover:bg-pink-50/60'}`}
              style={{
                top: i * slotHeight, height: slotHeight,
                borderTop:    isHour ? '2px solid #6b7280' : 'none',
                borderBottom: isHour ? '1px solid #e5e7eb' : type === 'half' ? '1px solid #d1d5db' : '1px solid #e5e7eb',
              }}
              onDoubleClick={() => !dragInfo && openAddModal(mId, i)}
              onDragOver={(e) => onSlotDragOver(e, mId, i)}
              onDrop={(e) => onSlotDrop(e, mId, i)}>
              {!dragInfo && <div className="absolute top-0.5 right-1 opacity-0 group-hover:opacity-100"><Plus size={9} className="text-pink-300" /></div>}
            </div>
          );
        })}

        {/* Off-hours overlay — clickable to quick-edit the schedule for this
            technician/day. Pointer events are skipped while a drag is in
            progress so drops still pass through to the slot grid underneath. */}
        {mId && offBandsByManicurist.get(mId)?.map((band, idx) => (
          <div
            key={`offband-${idx}`}
            className={`absolute left-0 right-0 group/off transition-colors ${
              dragInfo ? 'pointer-events-none' : 'cursor-pointer hover:bg-pink-100/40'
            }`}
            style={{
              top: band.top,
              height: band.height,
              backgroundColor: 'rgba(75, 85, 99, 0.15)',
              backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 6px, rgba(75, 85, 99, 0.08) 6px, rgba(75, 85, 99, 0.08) 12px)',
              zIndex: 1,
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingSchedule({
                manicuristId: mId,
                weekday: weekdayFromYmd(selectedDate),
                date: selectedDate,
              });
            }}
            title="Double-click to edit this technician's hours for this day"
          >
            {band.label && band.height > 24 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center font-mono text-[10px] font-bold tracking-wider text-gray-400 gap-0.5">
                <span>{band.label}</span>
                <span className="opacity-0 group-hover/off:opacity-100 transition-opacity text-pink-500 text-[9px] font-semibold">DOUBLE-CLICK TO EDIT</span>
              </div>
            )}
            {!band.label && band.height > 16 && (
              <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/off:opacity-100 transition-opacity">
                <span className="font-mono text-[9px] font-semibold text-pink-500 tracking-wider">DOUBLE-CLICK TO EDIT</span>
              </div>
            )}
          </div>
        ))}

        {blocks.map((blk, idx) => {
          const { appt, serviceName, occurrence, top, height, isFirst, hasRequest, requestedManicuristId, colManicuristId } = blk;
          const palette     = apptPalette(appt);
          const isDragging  = dragInfo?.apptId === appt.id && dragInfo?.serviceName === serviceName;
          const linkedQ     = queueByApptId.get(appt.id);
          const isCheckedOut = appt.status === 'completed';
          const isInService  = !isCheckedOut && linkedQ?.status === 'inProgress';
          const isWaitingQ   = !isCheckedOut && !isInService && !!linkedQ; // in queue, not yet started
          // Service complete but ticket not yet closed — stays light gray.
          const isAwaitingPayment = !isCheckedOut && !isInService && !isWaitingQ && awaitingPaymentApptIds.has(appt.id);
          const isCheckedIn  = !isCheckedOut && !isInService && !isWaitingQ && !isAwaitingPayment && appt.status === 'checked-in';
          // Walk-in pending placement: amber tint + a distinct border so the
          // receptionist can spot auto-placed blocks at a glance. Once they
          // drag it to the real slot, executeDrop clears isWalkIn and the
          // block reverts to whatever its lifecycle color would otherwise be.
          const isWalkInPending = !!appt.isWalkIn && !isCheckedOut;
          // Color progression: scheduled → light-gray (waiting Q) → light-gray (in service / awaiting payment) → dark-gray (checked out after ticket close)
          // Note: in-service softened from #d1d5db → #e5e7eb, checked-out from #1f2937 → #4b5563 per user request.
          const bg     = isCheckedOut       ? '#4b5563'
                       : isWalkInPending    ? '#fef3c7'
                       : isInService        ? '#e5e7eb'
                       : isAwaitingPayment  ? '#e5e7eb'
                       : isWaitingQ         ? '#f3f4f6'
                       : isCheckedIn        ? '#d1fae5'
                       : palette.bg;
          const border = isCheckedOut       ? '#1f2937'
                       : isWalkInPending    ? '#f59e0b'
                       : isInService        ? '#9ca3af'
                       : isAwaitingPayment  ? '#9ca3af'
                       : isWaitingQ         ? '#9ca3af'
                       : isCheckedIn        ? '#10b981'
                       : palette.border;
          const textColor = isCheckedOut       ? '#ffffff'
                          : isWalkInPending    ? '#78350f'
                          : isInService        ? '#374151'
                          : isAwaitingPayment  ? '#374151'
                          : isWaitingQ         ? '#6b7280'
                          : '#111827';
          const subTextColor = isCheckedOut       ? '#e5e7eb'
                             : isWalkInPending    ? '#92400e'
                             : isInService        ? '#6b7280'
                             : isAwaitingPayment  ? '#6b7280'
                             : isWaitingQ         ? '#9ca3af'
                             : '#6b7280';
          const pl = isFirst ? '14px' : '4px';

          // Locked = no drag/move allowed. Requested appts must be modified via the
          // edit modal so accidental hand-drags can't shift a client-requested
          // time/staff. Per user request 2026-05-22: every light-gray lifecycle
          // state (waiting-Q, in-service, awaiting-payment) is draggable too.
          // executeDrop assigns the destination column's manicurist as the new
          // service staff via serviceRequests. Only checked-out (paid) and
          // requested appts stay locked.
          // Standard locks: checked-out, OR client-requested (R badge) unless
          // the receptionist has double-clicked this specific R appt to
          // temporarily unlock it for a one-time move.
          const isRequestUnlocked = hasRequest && movableRequestApptId === appt.id;
          // Per user request 2026-05-24: dark-gray (checked-out / completed)
          // appts are draggable too, so the receptionist can fix a slot
          // placement after payment. The only lock left is the R-appt
          // double-click-to-unlock gate for client-requested manicurists.
          const isLocked = hasRequest && !isRequestUnlocked;
          // Treat the old "isCompleted" semantics (muted look, no action buttons) as
          // "checked out OR currently in a queue lifecycle". Hover action row stays
          // hidden in those states.
          const isCompleted = isCheckedOut;

          return (
            <div key={`${appt.id}-${serviceName}-${idx}`}
              data-appt-block={appt.id}
              draggable={!isLocked}
              onDragStart={(e) => {
                if (isLocked) return;
                // Starting a drag must cancel any pending nudge open + close
                // an open popup; nudging via popup AND dragging are mutually
                // exclusive gestures.
                if (apptClickTimerRef.current !== null) {
                  window.clearTimeout(apptClickTimerRef.current);
                  apptClickTimerRef.current = null;
                }
                if (nudgePopup && nudgePopup.apptId === appt.id) setNudgePopup(null);
                onDragStart(e, appt, serviceName, occurrence);
              }}
              onDragEnd={onDragEnd}
              className={`absolute left-1 right-1 rounded-lg overflow-hidden border-l-[3px] select-none group z-10 transition-all ${
                isDragging ? 'opacity-30 cursor-grabbing' : isLocked ? (isCompleted ? 'shadow-sm' : 'cursor-pointer shadow-sm hover:shadow-md') : 'cursor-grab hover:shadow-md hover:-translate-y-px shadow-sm'
              } ${
                hasRequest && !isCompleted && colManicuristId !== requestedManicuristId
                  ? 'ring-2 ring-pink-500 ring-offset-1 animate-pulse' : ''
              }`}
              style={{
                top: top + 1, height, backgroundColor: bg, borderLeftColor: border,
                borderTop: `1px solid ${border}60`, borderRight: `1px solid ${border}40`, borderBottom: `1px solid ${border}40`,
                // While a drag is in progress, let drop events pass through
                // OTHER appt blocks to the slot grid underneath. The source
                // block keeps normal pointer-events because changing them
                // mid-drag was observed (in Chrome) to abort the drag —
                // light gray (in-service / awaiting-payment) appts stopped
                // moving at all. If we ever need to support drops onto the
                // source's own footprint (e.g. nudging a 30-min appt down
                // by 15 min within its current span), do it via an explicit
                // onDragOver + onDrop on the source block, NOT by yanking
                // pointer-events.
                pointerEvents: dragInfo && !isDragging ? 'none' : undefined,
              }}
              onClick={(e) => {
                if (isDragging || isCheckedOut) return;
                // Note: we DON'T skip on isLocked. R (client-requested) appts
                // are locked-for-drag by default but the nudge popup is a
                // safe, single-click micro-adjustment that changes the
                // SERVICE DURATION (not staff, not start time), so the R
                // lock's intent (prevent accidental staff moves) is
                // preserved.
                // If the click landed on the popup or one of the hover
                // action buttons, those handlers already e.stopPropagation;
                // this onClick still runs for clicks on the appt body.
                // Defer to allow dblclick to win.
                if (apptClickTimerRef.current !== null) {
                  window.clearTimeout(apptClickTimerRef.current);
                  apptClickTimerRef.current = null;
                }
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                apptClickTimerRef.current = window.setTimeout(() => {
                  apptClickTimerRef.current = null;
                  // If the popup is already open for THIS specific block
                  // (same appt + service + occurrence), the body click
                  // means "I'm done nudging" — commit and close.
                  if (
                    nudgePopup
                    && nudgePopup.apptId === appt.id
                    && nudgePopup.serviceName === serviceName
                    && nudgePopup.occurrence === occurrence
                  ) {
                    commitNudgeNow();
                    return;
                  }
                  // Different block (or no popup yet) — commit any open one
                  // first so we don't strand a draft, then open a fresh one.
                  if (nudgePopup) commitNudgeNow();
                  // Resolve the ServiceRequest by (service, occurrence) so
                  // we know the current adjustment, then compute the base
                  // duration WITHOUT the appt adjustment so the popup can
                  // show a meaningful delta. svcDuration with adjustment=0
                  // gives exactly that.
                  const allReqs = appt.serviceRequests ?? [];
                  let occCounter = 0;
                  let matched: ServiceRequest | null = null;
                  for (const r of allReqs) {
                    if (r.service !== serviceName) continue;
                    if (occCounter === occurrence) { matched = r; break; }
                    occCounter += 1;
                  }
                  const baseDur = svcDuration(serviceName, colManicuristId, 0);
                  setNudgePopup({
                    apptId: appt.id,
                    serviceName,
                    occurrence,
                    baseDuration: baseDur,
                    originalAdjustment: matched?.durationAdjustment ?? 0,
                    draftAdjustment: matched?.durationAdjustment ?? 0,
                    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
                  });
                }, 220);
              }}
              onDoubleClick={() => {
                if (isDragging) return;
                // Cancel any pending nudge-popup open from the preceding
                // click of this double-click pair — the user wanted the
                // dblclick behaviour, not the nudge popup.
                if (apptClickTimerRef.current !== null) {
                  window.clearTimeout(apptClickTimerRef.current);
                  apptClickTimerRef.current = null;
                }
                if (nudgePopup && nudgePopup.apptId === appt.id) setNudgePopup(null);
                // R appts: double-click toggles the one-time-move unlock
                // instead of opening the edit modal. The receptionist
                // confirmed they actually want to drag a client-requested
                // appointment. The R badge starts pulsing while unlocked
                // so they get visual feedback.
                if (hasRequest && !isCheckedOut) {
                  setMovableRequestApptId((prev) => prev === appt.id ? null : appt.id);
                  return;
                }
                openEditModalGated(appt);
              }}>

              {/* Caution overlay — 5 faint diagonal warning stripes tucked
                  into the bottom-right corner of the block. Subtle visual
                  cue so receptionists notice the flag without the stripes
                  cluttering the whole appointment card. SVG line endpoints
                  fall in the bottom-right quadrant; non-scaling-stroke keeps
                  the lines a constant width regardless of block size. */}
              {appt.caution && (
                <svg
                  className="absolute inset-0 pointer-events-none"
                  width="100%" height="100%"
                  preserveAspectRatio="none"
                  viewBox="0 0 100 100"
                  style={{ zIndex: 2 }}
                >
                  {[
                    { x1: 50, y1: 100, x2: 100, y2: 50 },
                    { x1: 60, y1: 100, x2: 100, y2: 60 },
                    { x1: 70, y1: 100, x2: 100, y2: 70 },
                    { x1: 80, y1: 100, x2: 100, y2: 80 },
                    { x1: 90, y1: 100, x2: 100, y2: 90 },
                  ].map((l, i) => (
                    <line
                      key={i}
                      x1={l.x1} y1={l.y1}
                      x2={l.x2} y2={l.y2}
                      stroke="rgba(220,38,38,0.35)"
                      strokeWidth={1.5}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
              )}

              <div className="px-1.5 py-1 h-full flex flex-col overflow-hidden gap-0.5">
                <div className="flex items-center gap-1 min-w-0">
                  {!isLocked && <GripVertical size={10} className="text-gray-400 flex-shrink-0 cursor-grab" />}
                  <p className="font-mono text-[13px] font-bold truncate leading-tight flex-1"
                    style={{ color: textColor }}>
                    {appt.clientName || 'Walk-in'}
                  </p>
                  {isFirst && appt.time && (
                    <span className="font-mono text-[10px] font-semibold flex-shrink-0 leading-tight"
                      style={{ color: subTextColor }}>
                      {formatTimeOfDay(appt.time)}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 min-w-0" style={{ paddingLeft: pl }}>
                  <p className="font-mono text-xs font-semibold truncate leading-tight flex-1"
                    style={{ color: (isCheckedOut || isInService || isWaitingQ) ? subTextColor : border }}>
                    {serviceName}
                  </p>
                  {hasRequest && (
                    <span
                      className={`flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white font-bold text-[9px]${
                        isRequestUnlocked ? ' animate-pulse ring-2 ring-red-300' : ''
                      }`}
                      title={isRequestUnlocked ? 'Manicurist requested — UNLOCKED, drag to move' : 'Manicurist requested (double-click to unlock for move)'}
                    >R</span>
                  )}
                  {appt.sameTime && (
                    <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white font-bold text-[9px]" title="Same time">S</span>
                  )}
                  {collidingApptIds.has(appt.id) && (
                    <span
                      className="flex-shrink-0 inline-flex items-center justify-center px-1 h-4 rounded-full bg-red-500 text-white font-bold text-[8px] tracking-wider"
                      title="Overlaps another appointment at this time in this column"
                    >!</span>
                  )}
                  {appt.partyId && (
                    <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-purple-500 text-white font-bold text-[9px]" title="Party group">P</span>
                  )}
                  {appt.isWalkIn && !isCheckedOut && (
                    <span
                      className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-pink-500 text-white font-bold text-[9px] animate-pulse ring-2 ring-pink-300"
                      title="Walk-in (auto-placed — drag to the real slot)"
                    >W</span>
                  )}
                  {appt.notes && appt.notes.trim() && (
                    <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-sky-400 text-white font-bold text-[9px]" title={appt.notes}>N</span>
                  )}
                </div>

                {/* Per-block time label removed — the appointment time already shows in the
                    top-right corner of the first block. The repeated time under each service
                    name was redundant and ate vertical space. */}

                {height > 36 && !isCheckedOut && (
                  <div className="flex gap-1 mt-auto opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ paddingLeft: pl }}
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={(e) => e.stopPropagation()}>
                    {appt.status === 'scheduled' && (
                      <button
                        draggable={false}
                        onMouseDown={(e) => e.stopPropagation()}
                        onDragStart={(e) => e.preventDefault()}
                        onClick={(e) => addApptToQueue(e, appt)}
                        title="Send whole appointment to waiting queue"
                        className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 font-mono text-[10px] font-bold">
                        Q
                      </button>
                    )}
                    <button
                      draggable={false}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDragStart={(e) => e.preventDefault()}
                      onClick={(e) => { e.stopPropagation(); openEditModalGated(appt); }}
                      title="Edit appointment"
                      className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 font-mono text-[9px] font-bold">
                      &#x270E;
                    </button>
                    <button
                      draggable={false}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDragStart={(e) => e.preventDefault()}
                      onClick={(e) => deleteSvcBlock(e, appt, serviceName)}
                      title="Remove this service"
                      className="p-0.5 rounded bg-red-100 text-red-500 hover:bg-red-200">
                      <Trash2 size={9} />
                    </button>
                    <button
                      draggable={false}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDragStart={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Cancel appointment for ${appt.clientName || 'Walk-in'}?`)) {
                          dispatch({ type: 'UPDATE_APPOINTMENT', id: appt.id, updates: { status: 'cancelled' } });
                        }
                      }}
                      title="Cancel appointment"
                      className="p-0.5 rounded bg-orange-100 text-orange-600 hover:bg-orange-200">
                      <XCircle size={9} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  const columns: (Manicurist | null)[] = [...manicurists];

  return (
    <>
      {/* Outer container — holds header (fixed) + body (scrolls) */}
      <div ref={containerRef} className="flex flex-col w-full h-full">

        {/* ── Fixed header row — never scrolls vertically ─────────────────── */}
        <div
          ref={headerRef}
          onScroll={onHeaderScroll}
          className="flex-shrink-0 overflow-x-auto overflow-y-hidden bg-white border-b-2 border-gray-300 shadow-sm"
          style={{ height: HEADER_H }}>
          <div className="flex" style={{ width: totalGridW, height: HEADER_H }}>
            {/* Time column header */}
            <div className="flex-shrink-0 sticky left-0 z-30 bg-white border-r border-gray-300 flex items-end justify-end pb-2 pr-2"
              style={{ width: TIME_COL_W }}>
              <span className="font-mono text-[9px] text-gray-400 tracking-widest">TIME</span>
            </div>
            {/* Manicurist column headers — drag the whole column header to reorder */}
            {columns.map((m) => {
              const mId = m ? m.id : null;
              const isReorderTarget = m && colDropTargetId === m.id;
              const isReorderSource = m && colDragId === m.id;
              const accentColor = m ? m.color : '#d1d5db';
              return (
                <div
                  key={mId ?? 'any'}
                  data-services-header
                  draggable={!!m}
                  onDragStart={(e) => m && onColDragStart(e, m.id)}
                  onDragEnd={onColDragEnd}
                  onDragOver={(e) => m && onColDragOver(e, m.id)}
                  onDrop={(e) => m && onColDrop(e, m.id)}
                  title={m ? 'Drag to reorder · double-click the triangle for services' : undefined}
                  className={`relative flex-shrink-0 flex items-center justify-center gap-1.5 px-2 border-r border-gray-200 transition-colors ${
                    m ? 'cursor-grab active:cursor-grabbing' : ''
                  } ${isReorderSource ? 'opacity-40' : ''} ${
                    isReorderTarget ? 'bg-pink-50 ring-2 ring-pink-300 ring-inset' : ''
                  }`}
                  style={{ width: colWidth }}>
                  {/* Color triangle to the left of the name — also serves as
                      the services-popover trigger. Single-click toggles it.
                      draggable={false} + stopPropagation on mousedown keeps
                      the parent's drag-to-reorder gesture from eating the
                      click. cursor-pointer makes it clear this is tappable. */}
                  {m && (
                    <span
                      role="button"
                      tabIndex={0}
                      draggable={false}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDragStart={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        const rect = (e.currentTarget.parentElement as HTMLElement)
                          ?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect();
                        setServicesPopover((cur) =>
                          cur && cur.id === m.id
                            ? null
                            : { id: m.id, left: rect.left, top: rect.bottom + 4 },
                        );
                      }}
                      title="Show services"
                      style={{
                        width: 0,
                        height: 0,
                        borderTop: '7px solid transparent',
                        borderBottom: '7px solid transparent',
                        borderLeft: `10px solid ${accentColor}`,
                        flexShrink: 0,
                        cursor: 'pointer',
                      }}
                    />
                  )}
                  <span className="font-mono text-lg font-bold text-gray-700 truncate text-center tracking-wider uppercase">
                    {m ? m.name : 'ANY'}
                  </span>
                  {/* Color bar under the name */}
                  <span
                    aria-hidden
                    className="absolute left-2 right-2 bottom-1 rounded-full pointer-events-none"
                    style={{ height: 3, backgroundColor: accentColor }}
                  />

                  {/* Popover for this column is rendered separately at the
                      root of the component as a fixed-position element so
                      the header's overflow-x-auto/y-hidden doesn't clip it. */}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Body — scrolls vertically and horizontally; horizontal synced to header ─ */}
        <div
          ref={bodyRef}
          onScroll={onBodyScroll}
          className={`flex-1 min-h-0 overflow-auto ${isPanning ? 'cursor-grabbing select-none' : 'cursor-grab'}`}>
          <div className="flex relative" style={{ width: totalGridW, height: TOTAL_H }}>
            {/* Time column (sticky left so it stays put on horizontal scroll) */}
            <div className="flex-shrink-0 sticky left-0 z-20 bg-white border-r border-gray-300" style={{ width: TIME_COL_W }}>
              {Array.from({ length: TOTAL_SLOTS }).map((_, i) => {
                const label = hourLabel(i);
                const isHour = slotType(i) === 'hour';
                return (
                  <div key={i} className="flex items-start justify-end pr-2 pt-0.5"
                    style={{ height: slotHeight, borderTop: isHour ? '2px solid #6b7280' : 'none', borderBottom: isHour ? '1px solid #e5e7eb' : slotType(i) === 'half' ? '1px solid #d1d5db' : '1px solid #e5e7eb' }}>
                    {label && <span className="font-mono text-[11px] text-gray-700 leading-none whitespace-nowrap font-bold">{label}</span>}
                  </div>
                );
              })}
            </div>
            {nowTopPx != null && (
              <div className="absolute z-20 pointer-events-none flex items-center" style={{ top: nowTopPx, left: TIME_COL_W, right: 0 }}>
                <div className="w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm -ml-1.5 flex-shrink-0" />
                <div className="flex-1 h-[2px] bg-red-400" style={{ opacity: 0.8 }} />
              </div>
            )}
            {columns.map((m) => renderColumn(m))}
          </div>
        </div>
      </div>

      {/* Cannot park here popup */}
      {cannotParkMsg && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-gray-900 text-white font-mono text-sm font-semibold px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3">
            <span className="text-red-400 text-lg">&#x26D4;</span>
            Cannot park here &mdash; {cannotParkMsg}
          </div>
        </div>
      )}

      {/* Pending drop confirmation for client-requested services */}
      {pendingOpen && (
        <ReceptionistPinGate
          open={!!pendingOpen}
          title={pendingOpen.kind === 'add' ? 'BOOK APPOINTMENT' : 'EDIT APPOINTMENT'}
          subtitle={
            pendingOpen.kind === 'add'
              ? 'Enter your PIN to open a new booking.'
              : `Enter your PIN to edit ${pendingOpen.appt.clientName || 'this appointment'}.`
          }
          confirmLabel="OPEN"
          tone="primary"
          pinOnly
          receptionists={state.manicurists.filter((m) => m.isReceptionist)}
          onCancel={() => setPendingOpen(null)}
          onConfirm={(receptionistId) => commitOpenModal(receptionistId)}
        />
      )}
      {pendingDrop && (() => {
        const targetMani = pendingDrop.mId ? state.manicurists.find((m) => m.id === pendingDrop.mId) : null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPendingDrop(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-bebas text-xl tracking-[2px] text-gray-900 mb-2">MOVE REQUESTED SERVICE?</h3>
              <p className="font-mono text-sm text-gray-500 mb-1">
                <span className="font-semibold text-gray-700">{pendingDrop.info.serviceName}</span> was requested for a specific manicurist.
              </p>
              {targetMani && <p className="font-mono text-sm text-gray-500 mb-4">Moving to <span className="font-semibold" style={{ color: targetMani.color }}>{targetMani.name}</span> at {formatTimeOfDay(slotToTime(pendingDrop.slot))}.</p>}
              <p className="font-mono text-xs text-amber-600 bg-amber-50 rounded-xl px-3 py-2 mb-4">&#x26A0; The client requested a specific technician for this service.</p>
              <div className="flex gap-3">
                <button onClick={() => setPendingDrop(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 font-mono text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">KEEP ORIGINAL</button>
                <button onClick={() => { executeDrop(pendingDrop.info, pendingDrop.mId, pendingDrop.slot); setPendingDrop(null); }} className="flex-1 py-2.5 rounded-xl bg-amber-500 text-white font-mono text-sm font-semibold hover:bg-amber-600 transition-colors">MOVE ANYWAY</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Nudge popup — small fixed-position widget anchored to the
          service block being adjusted. Receptionist taps +5/-5 to grow
          or shrink THIS SERVICE's duration only (not the appt start time,
          not any other service in the same appt), then taps the appt
          body or outside to commit. Esc discards. The widget shows the
          resolved total duration in minutes plus the running delta. */}
      {nudgePopup && (() => {
        const POP_W = 188;
        const POP_H = 78;
        const GAP = 6;
        // Try to render above the appt; if that would clip the viewport
        // top, drop below instead. Centered horizontally over the block,
        // clamped to the viewport so it never escapes off-screen.
        const aboveTop = nudgePopup.rect.top - POP_H - GAP;
        const belowTop = nudgePopup.rect.top + nudgePopup.rect.height + GAP;
        const top = aboveTop >= 8 ? aboveTop : belowTop;
        const desiredLeft = nudgePopup.rect.left + nudgePopup.rect.width / 2 - POP_W / 2;
        const left = Math.max(8, Math.min(window.innerWidth - POP_W - 8, desiredLeft));
        const effective = Math.max(5, nudgePopup.baseDuration + nudgePopup.draftAdjustment);
        const delta = nudgePopup.draftAdjustment - nudgePopup.originalAdjustment;
        const sign = delta > 0 ? '+' : '';
        return (
          <div
            data-nudge-popup="1"
            className="fixed z-30 bg-white rounded-xl shadow-xl border border-gray-200 flex items-center gap-1.5 px-2 py-1.5 select-none"
            style={{ top, left, width: POP_W, height: POP_H }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setNudgePopup((p) => p ? {
                  ...p,
                  draftAdjustment: nudgeClampAdjustment(p.baseDuration, p.draftAdjustment - 5),
                } : null);
              }}
              className="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 active:bg-gray-300 text-gray-700 font-mono text-base font-bold flex items-center justify-center"
              title="Shorten by 5 minutes"
            >
              −
            </button>
            <div className="flex-1 text-center">
              <div className="font-mono text-sm font-bold text-gray-900 leading-tight">
                {effective} min
              </div>
              <div className="font-mono text-[9px] tracking-wider text-gray-400 leading-tight uppercase truncate">
                {delta === 0 ? 'no change' : `${sign}${delta} from saved`}
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setNudgePopup((p) => p ? {
                  ...p,
                  draftAdjustment: nudgeClampAdjustment(p.baseDuration, p.draftAdjustment + 5),
                } : null);
              }}
              className="w-9 h-9 rounded-lg bg-gray-100 hover:bg-gray-200 active:bg-gray-300 text-gray-700 font-mono text-base font-bold flex items-center justify-center"
              title="Extend by 5 minutes"
            >
              +
            </button>
          </div>
        );
      })()}

      {/* Quick schedule editor — opened by clicking a grayed off-hours band.
          This edits ONLY the selected date (writes a staff_schedule_overrides
          row), not the recurring weekly blueprint. Permanent recurring
          changes still live in the Blueprint → Staff → Weekly Hours UI. */}
      {editingSchedule && (() => {
        const mani = state.manicurists.find((m) => m.id === editingSchedule.manicuristId);
        if (!mani) return null;
        const targetDate = editingSchedule.date;
        const blueprintSched = state.staffSchedules.find(
          (s) => s.manicuristId === editingSchedule.manicuristId && s.weekday === editingSchedule.weekday,
        ) ?? null;
        const existingOverride = state.staffScheduleOverrides.find(
          (o) => o.manicuristId === editingSchedule.manicuristId && o.date === targetDate,
        ) ?? null;
        return (
          <DayScheduleOverrideModal
            manicurist={mani}
            date={targetDate}
            blueprint={blueprintSched}
            existingOverride={existingOverride}
            onClose={() => setEditingSchedule(null)}
            onSave={(draft) => {
              const mid = editingSchedule.manicuristId;
              dispatch({
                type: 'SET_STAFF_SCHEDULE_OVERRIDE',
                entry: {
                  id: existingOverride?.id ?? crypto.randomUUID(),
                  manicuristId: mid,
                  date: targetDate,
                  working: draft.working,
                  startTime: draft.startTime,
                  endTime: draft.endTime,
                  lunchStart: draft.hasLunch ? draft.lunchStart : null,
                  lunchEnd: draft.hasLunch ? draft.lunchEnd : null,
                  createdAt: existingOverride?.createdAt ?? Date.now(),
                },
              });
              setEditingSchedule(null);
            }}
            onClearOverride={() => {
              if (!existingOverride) return;
              dispatch({
                type: 'CLEAR_STAFF_SCHEDULE_OVERRIDE',
                manicuristId: editingSchedule.manicuristId,
                date: targetDate,
              });
              setEditingSchedule(null);
            }}
          />
        );
      })()}

      {/* Services popover — rendered at the component root with
          position:fixed so it escapes the header's overflow clipping.
          Anchored to the bounding rect captured when the header was
          double-clicked. */}
      {servicesPopover && (() => {
        const m = state.manicurists.find((mm) => mm.id === servicesPopover.id);
        if (!m) return null;
        const skills = m.skills ?? [];
        return (
          <div
            data-services-popover
            className="fixed z-[100] bg-white border border-gray-200 rounded-lg shadow-xl p-2 text-left"
            style={{
              left: servicesPopover.left,
              top: servicesPopover.top,
              minWidth: 180,
              maxWidth: 260,
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1.5 pb-1.5 border-b border-gray-100">
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  style={{
                    width: 0, height: 0,
                    borderTop: '4px solid transparent',
                    borderBottom: '4px solid transparent',
                    borderLeft: `6px solid ${m.color}`,
                  }}
                />
                <span className="font-mono text-[10px] tracking-wider font-bold text-gray-700 uppercase">
                  {m.name} · Services
                </span>
              </div>
              <button
                type="button"
                onClick={() => setServicesPopover(null)}
                className="text-gray-400 hover:text-gray-700 font-mono text-sm leading-none px-1"
                aria-label="Close"
              >×</button>
            </div>
            {skills.length === 0 ? (
              <p className="font-mono text-[10px] text-gray-400 italic px-1 py-2">
                No services assigned.
              </p>
            ) : (
              <ul className="space-y-0.5 max-h-[60vh] overflow-y-auto pr-1">
                {skills.map((s) => (
                  <li
                    key={s}
                    className="font-mono text-[11px] text-gray-700 px-1.5 py-0.5 rounded hover:bg-gray-50"
                  >
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}
    </>
  );
}
