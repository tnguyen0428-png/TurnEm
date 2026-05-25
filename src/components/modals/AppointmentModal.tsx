import { useState, useEffect, useMemo } from 'react';
import { X, ChevronDown, ChevronUp, Trash2, Printer } from 'lucide-react';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import { supabase } from '../../lib/supabase';
import {
  upsertCustomerFromIntake, toTitleCase, formatPhoneDashed,
  searchCustomers, displayCustomerName, normalizePhone, matchAppointments,
} from '../../lib/customers';
import type { Customer } from '../../types';
import { SERVICE_CATEGORIES } from '../../constants/services';
import { getTodayLA } from '../../utils/time';
import { resolveScheduleForDate } from '../../utils/schedule';
import type { ServiceType, ServiceRequest, Appointment } from '../../types';

interface AppointmentModalProps {
  mode: 'add' | 'edit';
}

interface SelectedService {
  serviceId: string;
  serviceName: string;
  turnValue: number;
  requestedManicuristIds: string[];
  // Per-appointment, per-service duration tweak in minutes. Stacks on top of
  // the base service duration and the assigned staff timeAdjustments.
  durationAdjustment: number;
}

// Parse a free-form time string ("130", "11", "9:30 am", "1330") into the
// canonical 24-hour "HH:MM" string the rest of the app expects.
//
// Salon hours are 8 AM to 8 PM, so when no AM/PM is given we auto-assign:
//   hours 1-7   → PM (1 PM…7 PM)
//   hour  8-11  → AM (8 AM…11 AM)
//   hour  12    → 12 PM (noon)
//   hours 13-23 → already 24-hour, kept as-is
// Returns null when the string can't be interpreted.
function parseTimeInput(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // Honor explicit AM/PM suffix if present
  let forced: 'am' | 'pm' | null = null;
  if (/p\.?m?\.?$/.test(s)) forced = 'pm';
  else if (/a\.?m?\.?$/.test(s)) forced = 'am';
  const body = s.replace(/[ap]\.?m?\.?$/, '').trim();

  let h: number;
  let m: number;
  if (body.includes(':')) {
    const [hStr, mStr] = body.split(':');
    h = parseInt(hStr, 10);
    m = parseInt(mStr || '0', 10);
  } else {
    const digits = body.replace(/\D/g, '');
    if (digits.length === 0) return null;
    if (digits.length <= 2) {
      h = parseInt(digits, 10);
      m = 0;
    } else if (digits.length === 3) {
      h = parseInt(digits.slice(0, 1), 10);
      m = parseInt(digits.slice(1), 10);
    } else if (digits.length === 4) {
      h = parseInt(digits.slice(0, 2), 10);
      m = parseInt(digits.slice(2), 10);
    } else {
      return null;
    }
  }
  if (isNaN(h) || isNaN(m) || m < 0 || m >= 60) return null;

  if (forced === 'am') {
    if (h === 12) h = 0;
  } else if (forced === 'pm') {
    if (h < 12) h += 12;
  } else {
    // Auto: 1-7 → PM (salon closed in early morning), 8-12 stay (8 AM–12 PM),
    // 13+ already 24-hour.
    if (h >= 1 && h <= 7) h += 12;
  }
  if (h < 0 || h > 23) return null;

  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function formatTo12Hr(hhmm: string): string {
  if (!hhmm || !hhmm.includes(':')) return hhmm;
  const [hStr, mStr] = hhmm.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (isNaN(h) || isNaN(m)) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return h12 + ':' + String(m).padStart(2, '0') + ' ' + ampm;
}

export default function AppointmentModal({ mode }: AppointmentModalProps) {
  const { state, dispatch } = useApp();

  const editing = mode === 'edit'
    ? state.appointments.find((a) => a.id === state.editingAppointmentId)
    : null;

  const today = getTodayLA();
  const draft = mode === 'add' ? state.appointmentDraft : null;


  // Customer match suggestions surfaced while the receptionist types name
  // or phone. Clicking one fills the form and pins the matched profile.
  const [matches, setMatches] = useState<Customer[]>([]);
  const [matchedCustomer, setMatchedCustomer] = useState<Customer | null>(null);
  // Pending delete for one of the matched-customer's upcoming appointments.
  // Holds the appt id while the ConfirmDialog is shown; cleared on confirm
  // (after dispatch) or cancel. Lets the receptionist scrub stale future
  // bookings without leaving the new-appointment flow.
  const [pendingDeleteApptId, setPendingDeleteApptId] = useState<string | null>(null);
  // Recap shown after a successful new booking — receptionist taps DONE
  // to dismiss. Edits skip this.
  const [recap, setRecap] = useState<null | {
    // Id of the primary appointment row that will be created if DONE is
    // pressed. The booking is NOT yet saved at this point — pressing EDIT
    // discards the recap and keeps the user on the form. Pressing DONE is
    // what actually dispatches ADD_APPOINTMENT.
    appointmentId: string;
    clientName: string;
    services: string[];
    date: string;
    time: string;
    staffName: string;
    serviceLines: Array<{ service: string; staffName: string }>;
    receptionistName: string;
    // Standing-appointment series outcome. `seriesDates` is every additional
    // booked date (excluding the primary one shown above). `skippedDates`
    // are dates that fell on a Blocked calendar day; `conflictDates` are
    // dates where the assigned staff already has another appointment at
    // this time. Both kinds are surfaced separately in the recap so the
    // receptionist knows whether to unblock the calendar or shift the time.
    seriesDates?: string[];
    skippedDates?: string[];
    conflictDates?: string[];
    // Pending payload — committed by the DONE handler so the booking only
    // hits state.appointments (and via the sync pipeline, Supabase) when the
    // receptionist confirms. Without this the appointment was being saved
    // the moment BOOK was clicked, even if the receptionist then hit EDIT
    // to fix a typo — surfaced by Kayla Nguyen 2026-05-25.
    pendingAppts: Appointment[];
    pendingCustomer: {
      firstName: string;
      lastName: string;
      phone: string;
      notes: string;
      permanentNote: boolean;
    };
  }>(null);
  // Pre-fill name + phone from the appointment draft. Used when the
  // BOOK APPT button on the ticket modal opens this flow — the customer's
  // info from the ticket carries over so the receptionist doesn't have to
  // retype it.
  const _draftName = state.appointmentDraft;
  const [clientFirstName, setClientFirstName] = useState(_draftName?.clientFirstName ?? '');
  const [clientLastName, setClientLastName] = useState(_draftName?.clientLastName ?? '');
  // Combined name used everywhere else in this modal (save payload, display).
  // The two inputs stay the single source of truth.
  const clientName = `${clientFirstName.trim()} ${clientLastName.trim()}`.trim();
  const [clientPhone, setClientPhone] = useState(_draftName?.clientPhone ?? '');

  // Debounced live search for existing customer profiles.
  useEffect(() => {
    const q = clientFirstName.trim() || clientLastName.trim() || clientPhone.trim();
    if (!q) { setMatches([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const rows = await searchCustomers(q, 6);
      if (!cancelled) setMatches(rows);
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [clientFirstName, clientLastName, clientPhone]);

  // Drop the pinned match if the form diverges from it.
  useEffect(() => {
    if (!matchedCustomer) return;
    const sameName =
      matchedCustomer.firstName === clientFirstName.trim() &&
      matchedCustomer.lastName === clientLastName.trim();
    const samePhone =
      normalizePhone(matchedCustomer.phone) === normalizePhone(clientPhone);
    if (!sameName || !samePhone) setMatchedCustomer(null);
  }, [matchedCustomer, clientFirstName, clientLastName, clientPhone]);

  function selectCustomer(c: Customer) {
    setClientFirstName(c.firstName);
    setClientLastName(c.lastName);
    setClientPhone(c.phone);
    setMatchedCustomer(c);
    setMatches([]);
  }
  const [selectedCategory, setSelectedCategory] = useState('');
  const [selectedServiceId, setSelectedServiceId] = useState('');
  const [selectedServices, setSelectedServices] = useState<SelectedService[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [date, setDate] = useState(draft?.date ?? today);
  const [time, setTime] = useState(draft?.time ?? '10:00');
  // Free-form time entry: receptionist can type '130' (auto → 1:30 PM),
  // '11' (→ 11:00 AM), '9:30am', etc. We keep the raw input here for
  // display and parse it on blur back into `time` (HH:MM 24-hour).
  const [timeRaw, setTimeRaw] = useState(formatTo12Hr(draft?.time ?? '10:00'));
  useEffect(() => { setTimeRaw(formatTo12Hr(time)); }, [time]);
  function commitTime() {
    const parsed = parseTimeInput(timeRaw);
    if (parsed) {
      setTime(parsed);
      setTimeRaw(formatTo12Hr(parsed));
    } else {
      setTimeRaw(formatTo12Hr(time));
    }
  }
  const [notes, setNotes] = useState('');
  // "Permanent note" — when checked, the note is saved to the customer
  // record (customers.notes) so it pre-populates on every future booking
  // for this person. Unchecked → note stays on the appointment only.
  const [permanentNote, setPermanentNote] = useState(false);

  // Prefill notes + check the "permanent" box when we land on a customer
  // with a saved note. Only fires when notes is currently empty so we
  // never clobber what the receptionist has been typing.
  useEffect(() => {
    if (mode !== 'add') return;
    if (!matchedCustomer) return;
    const stored = (matchedCustomer.notes ?? '').trim();
    if (!stored) return;
    if (notes.trim().length > 0) return;
    setNotes(stored);
    setPermanentNote(true);
  }, [mode, matchedCustomer, notes]);
  const [sameTime, setSameTime] = useState(false);
  // Standing-appointment series. When `isStandingAppt` is checked the cashier
  // also picks an interval (in days) and an end date; on save we book the
  // primary appt PLUS one extra row for each interval up through the end
  // date. Blocked calendar days are skipped and surfaced in the recap so the
  // receptionist can rebook them manually. The series itself isn't tracked
  // beyond the per-row appts (chose this over a series-id link to keep the
  // first ship simple — each row edits/cancels independently).
  const [isStandingAppt, setIsStandingAppt] = useState(false);
  const [standingIntervalDays, setStandingIntervalDays] = useState('21');
  const [standingEndDate, setStandingEndDate] = useState('');
  // Receptionist-confirmation when booking would overlap an existing
  // appointment in the same column. Holds the new-booking summary + the
  // list of conflicting existing appointments until the user confirms
  // (proceed) or cancels (close the dialog).
  interface ConflictInfo {
    manName: string;
    timeLabel: string;
    otherClient: string;
    serviceName: string;
  }
  interface BookingPreview {
    clientName: string;
    timeLabel: string;
    rows: Array<{ serviceName: string; manName: string }>;
    conflicts: ConflictInfo[];
  }
  const [pendingConflicts, setPendingConflicts] = useState<BookingPreview | null>(null);
  // Auto-assign popup state: when the receptionist tries to book with no
  // requested manicurist and no column draft, we try to auto-pick a skilled,
  // free manicurist. If none are free, this state holds the info shown to
  // the receptionist as an override prompt. `approved: true` is a sentinel
  // that means "book as unassigned" — the re-submitted handler sees it and
  // skips the auto-assign check.
  const [pendingAutoAssign, setPendingAutoAssign] = useState<{
    servicesLabel: string;
    timeLabel: string;
    approved: boolean;
  } | null>(null);
  const [partyGroup, setPartyGroup] = useState(false);
  // Caution flag — paints diagonal warning stripes over the appointment block
  // in the book so the salon can spot risky bookings at a glance.
  const [caution, setCaution] = useState(false);
  // Cancel-appointment confirmation gate. Set when the receptionist clicks
  // CANCEL APPT in edit mode; cleared once they confirm or back out.
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);

  const sortedServices = useMemo(
    () => [...state.salonServices].filter((s) => s.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
    [state.salonServices]
  );

  const availableCategories = useMemo(() => {
    const cats = new Set(sortedServices.map((s) => s.category).filter(Boolean));
    return SERVICE_CATEGORIES.filter((c) => cats.has(c));
  }, [sortedServices]);

  const servicesInCategory = useMemo(() => {
    if (!selectedCategory) return [];
    return sortedServices.filter((s) => s.category === selectedCategory);
  }, [sortedServices, selectedCategory]);

  const allStaffSorted = useMemo(
    () => [...state.manicurists].sort((a, b) => a.name.localeCompare(b.name)),
    [state.manicurists]
  );

  useEffect(() => {
    if (editing) {
      const _s = (editing.clientName ?? '').trim();
      const _i = _s.indexOf(' ');
      setClientFirstName(_i === -1 ? _s : _s.slice(0, _i));
      setClientLastName(_i === -1 ? '' : _s.slice(_i + 1).trim());
      setClientPhone(editing.clientPhone);
      setDate(editing.date);
      setTime(editing.time);
      setNotes(editing.notes);
      // Edit mode: look up the customer by phone so we can detect when
      // this appointment's note matches the customer's permanent note,
      // and pre-check the box accordingly.
      const _phoneForLookup = (editing.clientPhone ?? '').trim();
      if (_phoneForLookup) {
        searchCustomers(_phoneForLookup, 5).then((rows) => {
          const c = rows.find((r) => normalizePhone(r.phone) === normalizePhone(_phoneForLookup));
          if (!c) return;
          setMatchedCustomer(c);
          if ((c.notes ?? '').trim() && (c.notes ?? '').trim() === (editing.notes ?? '').trim()) {
            setPermanentNote(true);
          }
        }).catch(() => {});
      }
      setSameTime(editing.sameTime || false);
      setPartyGroup(!!editing.partyId);
      setCaution(!!editing.caution);

      const svcs = editing.services?.length ? editing.services : [editing.service];
      // Use occurrence tracking for duplicate service names
      const occCount: Record<string, number> = {};
      const restored: SelectedService[] = svcs.map((svcName) => {
        const svc = state.salonServices.find((s) => s.name === svcName);
        const occ = occCount[svcName] ?? 0;
        occCount[svcName] = occ + 1;
        // Only show assignment if it was an EXPLICIT client request (not a drag placement)
        const reqs = (editing.serviceRequests || []).filter((r) => r.service === svcName);
        const req  = reqs[occ] ?? null;
        return {
          serviceId: svc?.id || svcName,
          serviceName: svcName,
          turnValue: svc?.turnValue ?? 1,
          requestedManicuristIds: (req?.clientRequest === true) ? (req.manicuristIds || []) : [],
          durationAdjustment: req?.durationAdjustment ?? 0,
        };
      });
      setSelectedServices(restored);
      setExpandedIndex(null); // don't auto-expand — user clicks the arrow to open
    }
  }, [editing]);

  function handleRemoveService(index: number) {
    setSelectedServices((prev) => prev.filter((_, i) => i !== index));
    if (expandedIndex === index) setExpandedIndex(null);
    else if (expandedIndex !== null && expandedIndex > index) setExpandedIndex(expandedIndex - 1);
  }

  function bumpDurationAdjustment(index: number, deltaMinutes: number) {
    setSelectedServices((prev) =>
      prev.map((s, i) => (i === index ? { ...s, durationAdjustment: s.durationAdjustment + deltaMinutes } : s))
    );
  }

  function toggleManicurist(index: number, manicuristId: string) {
    setSelectedServices((prev) =>
      prev.map((s, i) => {
        if (i !== index) return s;
        const has = s.requestedManicuristIds.includes(manicuristId);
        return {
          ...s,
          requestedManicuristIds: has
            ? s.requestedManicuristIds.filter((id) => id !== manicuristId)
            : [...s.requestedManicuristIds, manicuristId],
        };
      })
    );
  }

  function durOf(svcName: string, manId: string | null, apptAdj?: number): number {
    const base = state.salonServices.find((s) => s.name === svcName)?.duration ?? 60;
    const staffAdj = manId
      ? ((state.manicurists.find((mm) => mm.id === manId)?.timeAdjustments?.[svcName]) || 0)
      : 0;
    return Math.max(base + staffAdj + (apptAdj || 0), 5);
  }

  // Build a per-column list of busy intervals across all OTHER appointments
  // on the same date. Used to detect overlap when the receptionist tries to
  // save a new (or moved/edited) appointment.
  function computeOtherAppointmentOccupancy(
    targetDate: string = date,
  ): Map<string, Array<{ apptId: string; clientName: string; startMin: number; endMin: number; timeLabel: string }>> {
    const map = new Map<string, Array<{ apptId: string; clientName: string; startMin: number; endMin: number; timeLabel: string }>>();
    for (const a of state.appointments) {
      if (mode === 'edit' && editing && a.id === editing.id) continue;
      if (a.date !== targetDate) continue;
      if (a.status === 'cancelled' || a.status === 'no-show') continue;
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
        const dur = durOf(svcName, manId, req?.durationAdjustment);
        let startMin: number;
        if (req?.startTime) {
          const [h, m] = req.startTime.split(':').map(Number);
          startMin = h * 60 + m;
        } else if (a.sameTime) {
          startMin = apptStartMin;
        } else {
          startMin = apptStartMin + elapsed;
        }
        if (manId) {
          const arr = map.get(manId) ?? [];
          arr.push({
            apptId: a.id,
            clientName: a.clientName || 'Client',
            startMin,
            endMin: startMin + dur,
            timeLabel: req?.startTime ?? a.time,
          });
          map.set(manId, arr);
        }
        if (!a.sameTime) elapsed += dur;
      }
    }
    return map;
  }

  // Try to auto-pick a manicurist for an unrequested appointment. Returns:
  //  - { kind: 'found', manicuristId }: a skilled, free manicurist exists
  //  - { kind: 'noneAvailable' }: no skilled manicurist is free (or no
  //    manicurist has the required skills at all) — receptionist should be
  //    prompted to override and book unassigned.
  // Pick a distinct skilled+free manicurist for EACH service in the
  // appointment so a 2-pedicure booking with no requested staff lands on
  // two different columns (not stacked back-to-back under one manicurist).
  // Greedy backtracking; prefers manicurists whose columns are close
  // together (by sort_order proxy) so the resulting blocks appear "near
  // each other" in the book.
  function findAutoAssignManicurists(): { kind: 'found'; perService: (string | null)[] } | { kind: 'noneAvailable' } {
    const [sh, sm] = time.split(':').map(Number);
    const apptStartMin = sh * 60 + sm;
    const occupancy = computeOtherAppointmentOccupancy();

    // Compute the appointment's weekday (0=Sun..6=Sat) from the date
    // string so we can look up each manicurist's recurring schedule.
    // apptWeekday used to be derived here; the resolver now owns weekday
    // computation internally so we no longer need it at this layer.

    // Inline helper: does this manicurist actually work the requested time
    // window on the appointment date? Skips when they're on time-off for
    // the date, have no schedule for the weekday (= recurring day off),
    // their hours don't cover the window, or the window overlaps lunch.
    function manicuristIsWorking(manicuristId: string, startMin: number, endMin: number): boolean {
      // Resolver layers time-off > per-date override > weekly blueprint.
      // A null result means the tech is off for the date entirely; otherwise
      // we still need to verify the requested window fits inside the
      // resolved hours and doesn't overlap the (possibly overridden) lunch.
      const sched = resolveScheduleForDate(
        manicuristId, date, state.staffSchedules, state.staffScheduleOverrides, state.staffTimeOff,
      );
      if (!sched) return false;
      const toMin = (hhmm: string): number => {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
      };
      const schedStart = toMin(sched.startTime);
      const schedEnd = toMin(sched.endTime);
      if (startMin < schedStart || endMin > schedEnd) return false;
      if (sched.lunchStart && sched.lunchEnd) {
        const lStart = toMin(sched.lunchStart);
        const lEnd = toMin(sched.lunchEnd);
        if (startMin < lEnd && endMin > lStart) return false;
      }
      return true;
    }

    // state.manicurists is sorted by sort_order (column order in the book).
    const orderIdxById = new Map<string, number>();
    state.manicurists.forEach((m, idx) => orderIdxById.set(m.id, idx));

    // For each service, the set of manicurists that are (a) skilled,
    // (b) scheduled to work the requested time window on that weekday
    // (not off, not on lunch, not on time-off), and (c) free of overlap
    // with other booked appointments in that window.
    const candidatesByService: string[][] = selectedServices.map((s) => {
      const skilled = state.manicurists.filter((m) => m.skills.includes(s.serviceName as ServiceType));
      return skilled
        .filter((m) => {
          const dur = durOf(s.serviceName, m.id, s.durationAdjustment);
          const endMin = apptStartMin + dur;
          if (!manicuristIsWorking(m.id, apptStartMin, endMin)) return false;
          const arr = occupancy.get(m.id) ?? [];
          return !arr.some((iv) => iv.startMin < endMin && iv.endMin > apptStartMin);
        })
        .map((m) => m.id);
    });
    if (candidatesByService.some((c) => c.length === 0)) return { kind: 'noneAvailable' };

    // Greedy backtracking ordered by most-constrained service first.
    const serviceOrder = candidatesByService
      .map((_, idx) => idx)
      .sort((a, b) => candidatesByService[a].length - candidatesByService[b].length);
    const used = new Set<string>();
    const result: (string | null)[] = new Array(selectedServices.length).fill(null);

    function pick(orderIdx: number): boolean {
      if (orderIdx >= serviceOrder.length) return true;
      const svcIdx = serviceOrder[orderIdx];
      const cands = candidatesByService[svcIdx].filter((id) => !used.has(id));
      if (cands.length === 0) return false;
      // Sort by proximity to already-picked columns so adjacent service
      // blocks land in adjacent (or close) columns.
      cands.sort((a, b) => {
        if (used.size === 0) return (orderIdxById.get(a) ?? 0) - (orderIdxById.get(b) ?? 0);
        const dist = (id: string) => Math.min(
          ...Array.from(used).map((u) => Math.abs((orderIdxById.get(id) ?? 0) - (orderIdxById.get(u) ?? 0))),
        );
        return dist(a) - dist(b);
      });
      for (const c of cands) {
        used.add(c);
        result[svcIdx] = c;
        if (pick(orderIdx + 1)) return true;
        used.delete(c);
        result[svcIdx] = null;
      }
      return false;
    }

    if (!pick(0)) return { kind: 'noneAvailable' };
    return { kind: 'found', perService: result };
  }

  function findBookingPreview(): BookingPreview {
    const occupancy = computeOtherAppointmentOccupancy();
    const [sh, sm] = time.split(':').map(Number);
    const apptStartMin = sh * 60 + sm;
    let elapsed = 0;
    const conflicts: ConflictInfo[] = [];
    const rows: Array<{ serviceName: string; manName: string }> = [];
    for (const s of selectedServices) {
      const manId =
        s.requestedManicuristIds[0]
        ?? (mode === 'edit' && editing ? editing.manicuristId : null)
        ?? state.appointmentDraft?.manicuristId
        ?? null;
      const manName = manId
        ? (state.manicurists.find((mm) => mm.id === manId)?.name ?? '?')
        : 'Unassigned';
      rows.push({ serviceName: s.serviceName as string, manName });
      if (!manId) {
        if (!sameTime) elapsed += durOf(s.serviceName as string, null, s.durationAdjustment);
        continue;
      }
      const dur = durOf(s.serviceName as string, manId, s.durationAdjustment);
      const startMin = sameTime ? apptStartMin : apptStartMin + elapsed;
      const endMin = startMin + dur;
      const arr = occupancy.get(manId) ?? [];
      for (const iv of arr) {
        if (iv.startMin < endMin && iv.endMin > startMin) {
          conflicts.push({
            manName,
            timeLabel: iv.timeLabel,
            otherClient: iv.clientName,
            serviceName: s.serviceName as string,
          });
        }
      }
      if (!sameTime) elapsed += dur;
    }
    const newClientName = clientName.trim() || 'Walk-in';
    return { clientName: newClientName, timeLabel: time, rows, conflicts };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedServices.length === 0) return;

    // Receptionist confirmation gate: if the booking would land on an
    // already-occupied column at the target time, ask before committing.
    // pendingConflicts === null means the check hasn't run yet for this
    // click; once the user confirms we re-run handleSubmit and it skips
    // the check (pendingConflicts.conflicts is set to [] as a sentinel).
    if (pendingConflicts === null) {
      const preview = findBookingPreview();
      if (preview.conflicts.length > 0) {
        setPendingConflicts(preview);
        return;
      }
    }

    const services = selectedServices.map((s) => s.serviceName as ServiceType);

    // Build one entry per service occurrence — merges client request + existing placement/startTime.
    // This avoids duplicate entries that would confuse occurrence-based routing.
    const existingReqs = editing?.serviceRequests || [];
    // If the user explicitly changed the appointment time in the modal, drop all per-service
    // startTime overrides so the whole appointment moves to the new time instead of the
    // old per-service times overriding it. Same when "Same time" is checked — the
    // intent is every service starts at the appointment time, no per-service override.
    const timeChanged = mode === 'edit' && editing && editing.time !== time;
    const forceUnifiedTime = timeChanged || sameTime;
    const occCount: Record<string, number> = {};
    const serviceRequests: ServiceRequest[] = [];

    for (const s of selectedServices) {
      const occ = occCount[s.serviceName] ?? 0;
      occCount[s.serviceName] = occ + 1;
      // Find existing entry for this service/occurrence (preserves startTime from dragging)
      const reqsForSvc = existingReqs.filter((r) => r.service === s.serviceName);
      const existingReq = reqsForSvc[occ] ?? null;
      const preservedStartTime = forceUnifiedTime ? undefined : existingReq?.startTime;
      // Only attach the per-appointment adjustment when it is non-zero so the
      // JSON payload stays tidy and toggling back to 0 clears it from the row.
      const apptAdj = s.durationAdjustment !== 0 ? { durationAdjustment: s.durationAdjustment } : {};

      if (s.requestedManicuristIds.length > 0) {
        // Client request: merge with existing startTime so block stays at its dragged position
        serviceRequests.push({
          service: s.serviceName as ServiceType,
          manicuristIds: s.requestedManicuristIds,
          clientRequest: true as const,
          startTime: preservedStartTime,
          ...apptAdj,
        });
      } else if (existingReq && existingReq.clientRequest !== true) {
        // No client request — keep existing placement entry (startTime + column from drag),
        // but drop the startTime if the user just moved the whole appointment via the time field.
        // Always overwrite durationAdjustment from current modal state so toggling it down to 0 clears it.
        const base = forceUnifiedTime ? { ...existingReq, startTime: undefined } : existingReq;
        const { durationAdjustment: _drop, ...rest } = base;
        void _drop;
        serviceRequests.push({ ...rest, ...apptAdj });
      } else if (s.durationAdjustment !== 0) {
        // No request, no existing placement, but the receptionist set an
        // adjustment — mint a minimal entry so the book view sizes the block.
        serviceRequests.push({
          service: s.serviceName as ServiceType,
          manicuristIds: [],
          ...apptAdj,
        });
      }
      // If previously had clientRequest but now cleared — nothing added (fully unassigned)
    }

    const firstRequestedId = serviceRequests.find((r) => r.clientRequest === true)?.manicuristIds?.[0] ?? null;

    // Auto-assignment: brand-new booking, no specific manicurist requested,
    // no draft column → pick a DISTINCT skilled+free manicurist for EACH
    // service so they land in different columns at the same time slot
    // ("near each other" instead of stacked under one person back-to-back).
    // If we can't find enough distinct free staff, prompt the receptionist
    // and let them book as unassigned.
    let autoPerService: (string | null)[] | null = null;
    const shouldAutoAssign =
      mode === 'add' &&
      firstRequestedId == null &&
      !draft?.manicuristId &&
      selectedServices.length > 0;
    if (shouldAutoAssign) {
      if (pendingAutoAssign === null) {
        const result = findAutoAssignManicurists();
        if (result.kind === 'found') {
          autoPerService = result.perService;
        } else {
          setPendingAutoAssign({
            servicesLabel: selectedServices.map((s) => s.serviceName).join(', '),
            timeLabel: formatTo12Hr(time),
            approved: false,
          });
          return;
        }
      } else if (!pendingAutoAssign.approved) {
        return;
      }
      // approved → autoPerService stays null → book as fully unassigned.
    }

    // Inject per-service auto picks into serviceRequests. Each gets its
    // own column placement (manicuristIds = [picked]) but NOT clientRequest
    // — the customer didn't pick this manicurist, the system did.
    if (autoPerService) {
      const seen: Record<string, number> = {};
      for (let i = 0; i < selectedServices.length; i++) {
        const s = selectedServices[i];
        const pickedId = autoPerService[i];
        if (!pickedId) continue;
        const occ = seen[s.serviceName] ?? 0;
        seen[s.serviceName] = occ + 1;
        const matches = serviceRequests.filter((r) => r.service === s.serviceName);
        const existing = matches[occ];
        if (existing) {
          existing.manicuristIds = [pickedId];
        } else {
          const apptAdj = s.durationAdjustment !== 0 ? { durationAdjustment: s.durationAdjustment } : {};
          serviceRequests.push({
            service: s.serviceName as ServiceType,
            manicuristIds: [pickedId],
            ...apptAdj,
          });
        }
      }
    }

    // If no specific manicurist was requested in a service, fall back to the column
    // the receptionist clicked on when opening the modal (draft?.manicuristId)
    // For edit mode: preserve existing manicuristId if no new client request was made.
    // For add mode: fall back to the column the receptionist clicked on (draft?.manicuristId)
    // or the first auto-assigned id from above.
    const appointmentManicuristId = firstRequestedId
      ?? (mode === 'edit' && editing ? editing.manicuristId : null)
      ?? draft?.manicuristId
      ?? autoPerService?.find((id) => id != null) ?? null;
    const name = clientName.trim() || 'Walk-in';

    // Auto-link party group: when "Party group" is checked, look for another appointment
    // at the same date+time that already has a partyId and reuse it. Otherwise mint a new
    // partyId so the next booking at this slot will pick it up.
    let partyId: string | null = null;
    if (partyGroup) {
      // If we are editing and the appointment already has a partyId, keep it stable.
      if (mode === 'edit' && editing?.partyId) {
        partyId = editing.partyId;
      } else {
        const sibling = state.appointments.find(
          (a) =>
            a.id !== editing?.id &&
            a.date === date &&
            a.time === time &&
            a.partyId,
        );
        partyId = sibling?.partyId ?? crypto.randomUUID();
      }
    }

    if (mode === 'edit' && editing) {
      const editingReceptionistId = state.appointmentDraft?.editingReceptionistId ?? null;
      dispatch({
        type: 'UPDATE_APPOINTMENT',
        id: editing.id,
        updates: {
          clientName: name,
          clientPhone: clientPhone.trim(),
          service: services[0],
          services,
          serviceRequests,
          manicuristId: appointmentManicuristId,
          date,
          time,
          notes: notes.trim(),
          sameTime: autoPerService && selectedServices.length > 1 ? true : sameTime,
          partyId,
          caution,
          lastEditedByReceptionistId: editingReceptionistId,
        },
      });
    } else {
      // New booking — the receptionist already authenticated when they
      // double-clicked the slot, so the receptionist id is already on the
      // draft. Just save and recap.
      const receptionistId = state.appointmentDraft?.bookedByReceptionistId ?? null;
      const appt: Appointment = {
        id: crypto.randomUUID(),
        clientName: name,
        clientPhone: clientPhone.trim(),
        service: services[0],
        services,
        serviceRequests,
        manicuristId: appointmentManicuristId,
        date,
        time,
        notes: notes.trim(),
        status: 'scheduled',
        createdAt: Date.now(),
        sameTime: autoPerService && selectedServices.length > 1 ? true : sameTime,
        partyId,
        caution,
        bookedByReceptionistId: receptionistId,
      };
      // BOOK is now a preview action — we stage the primary + any standing
      // series appts on the recap and only dispatch on DONE (see
      // commitRecap below). This way pressing EDIT on the recap doesn't
      // leave a saved row behind.
      const pendingAppts: Appointment[] = [appt];

      // Standing-appointment series: generate one extra row per interval
      // step from (date + intervalDays) through standingEndDate. Each row
      // is fully independent (no series link / partyId) so editing or
      // cancelling one doesn't touch the others — matches the user's
      // decision on 2026-05-25. Blocked calendar days are skipped and
      // surfaced in the recap below. Time-slot conflicts (the staff already
      // has another appointment in this slot on that date) are also
      // skipped, into a separate "conflict" bucket so the receptionist can
      // see which dates need a different time.
      const seriesDates: string[] = [];
      const skippedDates: string[] = [];
      const conflictDates: string[] = [];
      const intervalDays = parseInt(standingIntervalDays, 10);
      if (
        isStandingAppt &&
        Number.isFinite(intervalDays) &&
        intervalDays > 0 &&
        standingEndDate &&
        standingEndDate > date
      ) {
        const blockedSet = new Set(
          state.calendarDays.filter((d) => d.status === 'blocked').map((d) => d.date),
        );
        // Compute the primary appt's per-manicurist time intervals once —
        // every series date reuses the same shape (same time, same staff,
        // same services), so we just check this footprint against each
        // future date's existing appts.
        const primaryIntervals = new Map<string, Array<{ startMin: number; endMin: number }>>();
        {
          const svcs = appt.services;
          const allReqs = appt.serviceRequests || [];
          const [sh, sm] = appt.time.split(':').map(Number);
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
              : (appt.manicuristId ?? null);
            const dur = durOf(svcName, manId, req?.durationAdjustment);
            let startMin: number;
            if (req?.startTime) {
              const [h, m] = req.startTime.split(':').map(Number);
              startMin = h * 60 + m;
            } else if (appt.sameTime) {
              startMin = apptStartMin;
            } else {
              startMin = apptStartMin + elapsed;
            }
            if (manId) {
              const arr = primaryIntervals.get(manId) ?? [];
              arr.push({ startMin, endMin: startMin + dur });
              primaryIntervals.set(manId, arr);
            }
            if (!appt.sameTime) elapsed += dur;
          }
        }
        // Iterate in local time (parse YYYY-MM-DD as a local date by
        // appending T00:00:00) so we never roll the date forward/backward
        // via UTC arithmetic.
        const cursor = new Date(date + 'T00:00:00');
        const endStop = new Date(standingEndDate + 'T00:00:00');
        cursor.setDate(cursor.getDate() + intervalDays);
        while (cursor <= endStop) {
          const yyyy = cursor.getFullYear();
          const mm = String(cursor.getMonth() + 1).padStart(2, '0');
          const dd = String(cursor.getDate()).padStart(2, '0');
          const dateStr = `${yyyy}-${mm}-${dd}`;
          if (blockedSet.has(dateStr)) {
            skippedDates.push(dateStr);
          } else {
            // Slot-conflict check: any existing appt on this date whose
            // staff and time window overlap one of the primary's intervals
            // means this date can't be auto-booked. Surfaced to the
            // receptionist below — not auto-skipped silently.
            const occupancyOnDate = computeOtherAppointmentOccupancy(dateStr);
            let hasConflict = false;
            outer: for (const [manId, intervals] of primaryIntervals) {
              const otherIntervals = occupancyOnDate.get(manId) ?? [];
              for (const myIv of intervals) {
                for (const otherIv of otherIntervals) {
                  if (otherIv.startMin < myIv.endMin && otherIv.endMin > myIv.startMin) {
                    hasConflict = true;
                    break outer;
                  }
                }
              }
            }
            if (hasConflict) {
              conflictDates.push(dateStr);
            } else {
              const seriesAppt: Appointment = {
                ...appt,
                id: crypto.randomUUID(),
                date: dateStr,
                createdAt: Date.now(),
                // Standalone — don't inherit the original's party grouping or
                // any one-off conflict-confirm partyId we minted above.
                partyId: null,
              };
              pendingAppts.push(seriesAppt);
              seriesDates.push(dateStr);
            }
          }
          cursor.setDate(cursor.getDate() + intervalDays);
        }
      }
      const receptionist = receptionistId
        ? state.manicurists.find((m) => m.id === receptionistId)
        : null;
      const staff = appointmentManicuristId
        ? state.manicurists.find((m) => m.id === appointmentManicuristId)?.name ?? ''
        : '';
      const serviceLines = selectedServices.map((s) => {
        const mId = s.requestedManicuristIds[0]
          ?? appointmentManicuristId
          ?? null;
        const staffName = mId
          ? (state.manicurists.find((m) => m.id === mId)?.name ?? '?')
          : 'Unassigned';
        return { service: s.serviceName as string, staffName };
      });
      setRecap({
        appointmentId: appt.id,
        clientName: name,
        services: services as string[],
        date,
        time,
        staffName: staff,
        serviceLines,
        receptionistName: receptionist?.name ?? '',
        seriesDates: seriesDates.length > 0 ? seriesDates : undefined,
        skippedDates: skippedDates.length > 0 ? skippedDates : undefined,
        conflictDates: conflictDates.length > 0 ? conflictDates : undefined,
        pendingAppts,
        pendingCustomer: {
          firstName: clientFirstName,
          lastName: clientLastName,
          phone: clientPhone,
          notes: notes.trim(),
          permanentNote,
        },
      });
      return;
    }

    // Edit path: dispatch already ran above. Sync the customer profile and
    // close the modal.
    void (async () => {
      const cid = await upsertCustomerFromIntake({
        firstName: clientFirstName,
        lastName: clientLastName,
        phone: clientPhone,
      });
      if (cid && permanentNote) {
        await supabase
          .from('customers')
          .update({ notes: notes.trim(), updated_at: new Date().toISOString() })
          .eq('id', cid);
      }
    })();

    handleClose();
  }

  function handleClose() {
    dispatch({ type: 'SET_MODAL', modal: null });
    dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: null });
    dispatch({ type: 'SET_APPOINTMENT_DRAFT', draft: null });
  }

  // Cancel (delete) the appointment from inside the edit modal. Removes
  // the appointment entirely — same as the trash icon on the AppointmentsScreen.
  function handleCancelAppointment() {
    if (mode !== 'edit' || !editing) return;
    dispatch({ type: 'DELETE_APPOINTMENT', id: editing.id });
    setShowCancelConfirm(false);
    handleClose();
  }

  return (
    <Modal
      title={mode === 'edit' ? 'EDIT APPOINTMENT' : 'NEW APPOINTMENT'}
      onClose={handleClose}
      width="max-w-xl"
      dock="right"
    >
      <form data-appointment-form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'edit' && editing && (
          <div className="font-mono text-[10px] tracking-wider text-gray-400 uppercase space-y-0.5">
            {editing.bookedByReceptionistId && (
              <p>
                Booked by{' '}
                <span className="font-bold text-gray-600">
                  {state.manicurists.find((m) => m.id === editing.bookedByReceptionistId)?.name ?? 'unknown'}
                </span>
                {editing.createdAt
                  ? ' · ' + new Intl.DateTimeFormat('en-US', {
                      month: 'short', day: 'numeric', year: 'numeric',
                      hour: 'numeric', minute: '2-digit',
                    }).format(new Date(editing.createdAt))
                  : ''}
              </p>
            )}
            {editing.lastEditedAt && editing.lastEditedByReceptionistId && (
              <p>
                Last edited by{' '}
                <span className="font-bold text-amber-700">
                  {state.manicurists.find((m) => m.id === editing.lastEditedByReceptionistId)?.name ?? 'unknown'}
                </span>
                {' · ' + new Intl.DateTimeFormat('en-US', {
                  month: 'short', day: 'numeric', year: 'numeric',
                  hour: 'numeric', minute: '2-digit',
                }).format(new Date(editing.lastEditedAt))}
              </p>
            )}
          </div>
        )}

        {matchedCustomer ? (
          <MatchedCustomerBanner
            customer={matchedCustomer}
            openAppointments={
              matchAppointments(matchedCustomer, state.appointments)
                .filter((a) => a.status === 'scheduled' || a.status === 'checked-in')
                .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
            }
            manicuristNameById={
              new Map(state.manicurists.map((m) => [m.id, m.name]))
            }
            onClear={() => { setMatchedCustomer(null); }}
            onDelete={(apptId) => { setPendingDeleteApptId(apptId); }}
          />
        ) : matches.length > 0 && mode !== 'edit' ? (
          <div className="rounded-xl border border-pink-200 bg-pink-50/40 p-3">
            <p className="font-mono text-[10px] tracking-wider font-bold text-pink-700 uppercase mb-1.5">
              Existing customers matching
            </p>
            <div className="flex flex-col gap-1">
              {matches.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => selectCustomer(c)}
                  className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-lg bg-white border border-pink-100 hover:bg-pink-100/40 transition-colors text-left"
                >
                  <span className="font-mono text-sm font-semibold text-gray-900 truncate">
                    {displayCustomerName(c)}
                  </span>
                  <span className="font-mono text-xs text-gray-500 flex-shrink-0">{c.phone || '—'}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Client info */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">FIRST NAME</label>
            <input
              type="text"
              value={clientFirstName}
              onChange={(e) => setClientFirstName(e.target.value)}
              onBlur={(e) => setClientFirstName(toTitleCase(e.target.value))}
              placeholder="First"
              autoFocus={mode === 'add'}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">LAST NAME</label>
            <input
              type="text"
              value={clientLastName}
              onChange={(e) => setClientLastName(e.target.value)}
              onBlur={(e) => setClientLastName(toTitleCase(e.target.value))}
              placeholder="Last"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">PHONE</label>
            <input
              type="tel"
              inputMode="numeric"
              value={clientPhone}
              onChange={(e) => {
                // Live-format: keep at most 10 digits, insert dashes at the 3rd
                // and 6th. Anything beyond is dropped so the field can't grow.
                const digits = e.target.value.replace(/\D/g, '').slice(0, 10);
                let out = digits;
                if (digits.length > 6) out = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
                else if (digits.length > 3) out = `${digits.slice(0, 3)}-${digits.slice(3)}`;
                setClientPhone(out);
              }}
              onBlur={(e) => setClientPhone(formatPhoneDashed(e.target.value))}
              placeholder="555-123-4567"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        {/* Services */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider">SERVICES</label>
          </div>

          <div className="flex gap-2 mb-3">
            <div className="flex-1">
              <select
                value={selectedCategory}
                onChange={(e) => { setSelectedCategory(e.target.value); setSelectedServiceId(''); }}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer"
              >
                <option value="">Category...</option>
                {availableCategories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <select
                value={selectedServiceId}
                onChange={(e) => {
                  const svc = sortedServices.find((s) => s.id === e.target.value);
                  if (!svc) return;
                  setSelectedServices((prev) => [
                    ...prev,
                    { serviceId: svc.id, serviceName: svc.name, turnValue: svc.turnValue, requestedManicuristIds: [], durationAdjustment: 0 },
                  ]);
                  setSelectedServiceId('');
                  setSelectedCategory('');
                }}
                disabled={!selectedCategory}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
              >
                <option value="">Select service...</option>
                {servicesInCategory.map((svc) => (
                  <option key={svc.id} value={svc.id}>{svc.name}</option>
                ))}
              </select>
            </div>
          </div>

          {selectedServices.length === 0 ? (
            <div className="text-center py-6 border-2 border-dashed border-gray-200 rounded-xl">
              <p className="font-mono text-xs text-gray-400">No services added yet</p>
              <p className="font-mono text-[10px] text-gray-300 mt-1">Select a category and service above</p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedServices.map((s, idx) => {
                const isExpanded = expandedIndex === idx;
                const skilledStaff = allStaffSorted.filter((m) => m.skills.includes(s.serviceName));
                const displayStaff = skilledStaff.length > 0 ? skilledStaff : allStaffSorted;

                const baseDuration = state.salonServices.find((ss) => ss.name === s.serviceName)?.duration ?? 60;
                const adjustedDuration = Math.max(baseDuration + s.durationAdjustment, 5);
                return (
                  <div key={idx}>
                    <div className="flex items-center justify-between px-3.5 py-3 rounded-xl border-2 border-pink-300 bg-pink-50 shadow-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="font-mono text-xs font-semibold text-pink-700">{s.serviceName}</p>
                          {s.requestedManicuristIds.length > 0 && (
                            <span className="flex items-center gap-1">
                              <span className="px-1.5 py-0.5 rounded-md font-mono text-[8px] font-bold bg-pink-500 text-white leading-none tracking-wide">REQ</span>
                              <span className="font-mono text-[10px] text-pink-600 font-semibold">
                                {s.requestedManicuristIds.map((id) => state.manicurists.find((m) => m.id === id)?.name).filter(Boolean).join(', ')}
                              </span>
                            </span>
                          )}
                          {s.durationAdjustment !== 0 && (
                            <span
                              className={`px-1.5 py-0.5 rounded-md font-mono text-[10px] font-semibold leading-none ${
                                s.durationAdjustment > 0 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                              }`}
                              title="Per-appointment duration adjustment"
                            >
                              {s.durationAdjustment > 0 ? '+' : ''}{s.durationAdjustment}m
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                          className="p-1 rounded hover:bg-pink-100 transition-colors"
                        >
                          {isExpanded ? <ChevronUp size={14} className="text-pink-500" /> : <ChevronDown size={14} className="text-pink-500" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRemoveService(idx)}
                          className="p-1 rounded hover:bg-pink-100 transition-colors"
                        >
                          <X size={14} className="text-pink-400" />
                        </button>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="mt-1 px-3 py-2.5 rounded-xl border border-gray-200 bg-white space-y-3">
                        <div>
                          <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider mb-2">
                            REQUEST MANICURIST <span className="text-gray-300 font-normal">(optional)</span>
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {displayStaff.map((m) => {
                              const isSelected = s.requestedManicuristIds.includes(m.id);
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => toggleManicurist(idx, m.id)}
                                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[10px] font-semibold transition-all ${
                                    isSelected ? 'bg-pink-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                                  }`}
                                >
                                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: m.color }} />
                                  {m.name}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div>
                          <p className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider mb-2">
                            DURATION ADJUSTMENT <span className="text-gray-300 font-normal">(optional)</span>
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => bumpDurationAdjustment(idx, -5)}
                              className="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 font-mono text-sm font-bold text-gray-600 transition-colors"
                            >
                              -
                            </button>
                            <span className={`font-mono text-xs font-semibold w-14 text-center tabular-nums ${
                              s.durationAdjustment > 0 ? 'text-amber-600' :
                              s.durationAdjustment < 0 ? 'text-emerald-600' : 'text-gray-400'
                            }`}>
                              {s.durationAdjustment > 0 ? '+' : ''}{s.durationAdjustment}m
                            </span>
                            <button
                              type="button"
                              onClick={() => bumpDurationAdjustment(idx, 5)}
                              className="w-7 h-7 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 font-mono text-sm font-bold text-gray-600 transition-colors"
                            >
                              +
                            </button>
                            <span className="font-mono text-[10px] text-gray-400 ml-2">
                              base {baseDuration}m &rarr; <span className="text-gray-600 font-semibold">{adjustedDuration}m</span>
                            </span>
                          </div>
                          <p className="font-mono text-[9px] text-gray-300 mt-1.5">
                            One-off tweak for this booking. Stacks with the staff member&apos;s own +/- if they have one.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Date & Time */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">DATE</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">TIME</label>
            <input
              type="text"
              inputMode="numeric"
              value={timeRaw}
              onChange={(e) => setTimeRaw(e.target.value)}
              onBlur={commitTime}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTime(); } }}
              placeholder="9:30 AM"
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        {/* Same-time / Party-group flags */}
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer hover:bg-gray-50 transition-colors select-none">
            <input
              type="checkbox"
              checked={sameTime}
              onChange={(e) => setSameTime(e.target.checked)}
              className="w-4 h-4 accent-green-500"
            />
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white font-bold text-[9px]">S</span>
            <span className="font-mono text-xs text-gray-700">Same time</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer hover:bg-gray-50 transition-colors select-none">
            <input
              type="checkbox"
              checked={partyGroup}
              onChange={(e) => setPartyGroup(e.target.checked)}
              className="w-4 h-4 accent-purple-500"
            />
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-purple-500 text-white font-bold text-[9px]">P</span>
            <span className="font-mono text-xs text-gray-700">Party group</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer hover:bg-gray-50 transition-colors select-none">
            <input
              type="checkbox"
              checked={caution}
              onChange={(e) => setCaution(e.target.checked)}
              className="w-4 h-4 accent-amber-500"
            />
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-white font-bold text-[9px]">C</span>
            <span className="font-mono text-xs text-gray-700">Caution</span>
          </label>
        </div>

        {/* Standing appointment — recurring booking on a fixed cadence. */}
        {mode === 'add' && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isStandingAppt}
                onChange={(e) => setIsStandingAppt(e.target.checked)}
                className="w-4 h-4 accent-indigo-500"
              />
              <span className="font-mono text-xs font-semibold text-indigo-800">Standing appointment</span>
              <span className="font-mono text-[10px] text-indigo-500">Repeat this booking on a fixed cadence</span>
            </label>
            {isStandingAppt && (
              <div className="grid grid-cols-2 gap-3 pl-6">
                <div>
                  <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">EVERY (DAYS)</label>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={standingIntervalDays}
                    onChange={(e) => setStandingIntervalDays(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
                  />
                </div>
                <div>
                  <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">BOOK THROUGH</label>
                  <input
                    type="date"
                    value={standingEndDate}
                    min={date}
                    onChange={(e) => setStandingEndDate(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Notes */}
        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">NOTES</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any special requests..."
            rows={2}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all resize-none"
          />
          <label className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border border-gray-200 bg-white cursor-pointer hover:bg-gray-50 transition-colors select-none">
            <input
              type="checkbox"
              checked={permanentNote}
              onChange={(e) => setPermanentNote(e.target.checked)}
              className="w-4 h-4 accent-pink-500"
            />
            <span className="font-mono text-[11px] text-gray-700">
              Save as permanent customer note (auto-loads on future bookings)
            </span>
          </label>
        </div>

        {mode === 'edit' ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowCancelConfirm(true)}
              className="px-4 py-3 rounded-xl bg-white border-2 border-red-200 text-red-600 font-mono text-sm font-semibold hover:bg-red-50 hover:border-red-300 active:scale-[0.98] transition-all"
            >
              CANCEL APPT
            </button>
            <button
              type="submit"
              disabled={selectedServices.length === 0}
              className="flex-1 py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
            >
              SAVE CHANGES
            </button>
          </div>
        ) : (
          <button
            type="submit"
            disabled={selectedServices.length === 0}
            className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
          >
            BOOK APPOINTMENT
          </button>
        )}
      </form>

      {showCancelConfirm && editing && (
        <ConfirmDialog
          message="Do you want to cancel this appointment?"
          confirmLabel="Yes, cancel"
          danger
          onConfirm={handleCancelAppointment}
          onCancel={() => setShowCancelConfirm(false)}
        />
      )}

      {pendingDeleteApptId && (() => {
        // Build a one-line description so the receptionist confirms the right
        // row, not just "an appointment". Pulls date / time / services from
        // state.appointments because the banner list is rebuilt on each
        // render and the row may be stale in a closure.
        const a = state.appointments.find((x) => x.id === pendingDeleteApptId);
        const dateLabel = a ? new Date(a.date + 'T12:00:00').toLocaleDateString('en-US', {
          weekday: 'short', month: 'short', day: 'numeric',
        }) : '';
        const timeLabel = (() => {
          if (!a) return '';
          const [hh, mm] = (a.time || '').split(':').map((s) => parseInt(s, 10));
          if (!Number.isFinite(hh)) return a.time;
          const ampm = hh >= 12 ? 'PM' : 'AM';
          const h12 = ((hh + 11) % 12) + 1;
          return `${h12}:${String(mm ?? 0).padStart(2, '0')} ${ampm}`;
        })();
        const services = a ? (a.services?.length ? a.services : [a.service]).join(', ') : '';
        const msg = a
          ? `Delete this appointment?\n${dateLabel} · ${timeLabel} · ${services}`
          : 'Delete this appointment?';
        return (
          <ConfirmDialog
            message={msg}
            confirmLabel="Delete"
            danger
            onConfirm={() => {
              dispatch({ type: 'DELETE_APPOINTMENT', id: pendingDeleteApptId });
              setPendingDeleteApptId(null);
            }}
            onCancel={() => setPendingDeleteApptId(null)}
          />
        );
      })()}

      {pendingConflicts !== null && pendingConflicts.conflicts.length > 0 && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => setPendingConflicts(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-100">
              <h3 className="font-bebas text-2xl tracking-widest text-amber-700">OVERLAP CONFIRMATION</h3>
              <p className="font-mono text-base text-gray-600 mt-1">This booking overlaps an existing appointment. Confirm to book on top, or cancel and adjust.</p>
            </div>

            {/* The new booking — client + time + each service line w/ assigned staff. */}
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="font-mono text-base font-bold tracking-wider text-gray-500 uppercase">Booking</p>
              <p className="font-mono text-base font-bold text-gray-900 mt-1">{pendingConflicts.clientName} — {pendingConflicts.timeLabel}</p>
              <ul className="mt-2 space-y-1">
                {pendingConflicts.rows.map((r, i) => (
                  <li key={i} className="font-mono text-base text-gray-800 flex items-baseline gap-2">
                    <span className="text-gray-400">•</span>
                    <span className="font-semibold">{r.manName}</span>
                    <span className="text-gray-500">— {r.serviceName}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Conflicts — existing appointments this booking overlaps. */}
            <div className="px-5 py-3 max-h-60 overflow-y-auto">
              <p className="font-mono text-base font-bold tracking-wider text-gray-500 uppercase">Conflicts</p>
              <ul className="mt-2 space-y-1.5">
                {pendingConflicts.conflicts.map((c, i) => (
                  <li key={i} className="font-mono text-base text-gray-800 flex items-start gap-2">
                    <span className="text-amber-500 mt-0.5">⚠</span>
                    <span>
                      <span className="font-semibold">{c.manName}</span> at {c.timeLabel} — already has {c.otherClient} ({c.serviceName})
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="px-5 py-4 bg-gray-50 border-t border-gray-100 flex justify-end gap-2">
              <button type="button"
                onClick={() => setPendingConflicts(null)}
                className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-base font-bold hover:bg-gray-100">
                CANCEL
              </button>
              <button type="button"
                onClick={() => {
                  // Sentinel: empty conflicts marks "already confirmed" so
                  // the next handleSubmit skips the conflict check.
                  setPendingConflicts({ ...pendingConflicts, conflicts: [] });
                  const form = document.querySelector<HTMLFormElement>('form[data-appointment-form]');
                  form?.requestSubmit();
                }}
                className="px-4 py-2 rounded-lg bg-amber-500 text-white font-mono text-base font-bold hover:bg-amber-600">
                BOOK ANYWAY
              </button>
            </div>
          </div>
        </div>
      )}
    {pendingAutoAssign && !pendingAutoAssign.approved && (
      <ConfirmDialog
        message={`Can't find enough free skilled manicurists for ${pendingAutoAssign.servicesLabel} at ${pendingAutoAssign.timeLabel} (one per service, no overlaps). Book as unassigned? You can drag each service to a manicurist's column later.`}
        confirmLabel="Book unassigned"
        onConfirm={() => {
          setPendingAutoAssign({ ...pendingAutoAssign, approved: true });
          const form = document.querySelector<HTMLFormElement>('form[data-appointment-form]');
          form?.requestSubmit();
        }}
        onCancel={() => setPendingAutoAssign(null)}
      />
    )}
    {recap && (
      <BookingRecapModal
        info={recap}
        onClose={() => {
          // DONE: commit the staged booking. Dispatch every pending appt
          // (primary + any standing-series rows), then run the customer
          // upsert (Blueprint profile + permanent-note write), then close
          // the modal. Nothing was written to state before this point so
          // backing out via EDIT leaves no orphan rows.
          const r = recap;
          for (const appt of r.pendingAppts) {
            dispatch({ type: 'ADD_APPOINTMENT', appointment: appt });
          }
          void (async () => {
            const c = r.pendingCustomer;
            const _first = (c.firstName ?? '').trim();
            const _last = (c.lastName ?? '').trim();
            const _phone = (c.phone ?? '').trim();
            if (!_first || !_last || !_phone) return;
            const cid = await upsertCustomerFromIntake({
              firstName: c.firstName,
              lastName: c.lastName,
              phone: c.phone,
            });
            if (cid && c.permanentNote) {
              await supabase
                .from('customers')
                .update({ notes: c.notes, updated_at: new Date().toISOString() })
                .eq('id', cid);
            }
          })();
          setRecap(null);
          handleClose();
        }}
        onEdit={() => {
          // EDIT: discard the staged booking and return to the form. The
          // form is still mounted with all the receptionist's inputs intact
          // — they can fix whatever was wrong and press BOOK again.
          setRecap(null);
        }}
      />
    )}
    </Modal>
  );
}


// ── Matched-customer banner ──────────────────────────────────────────────────

function MatchedCustomerBanner({
  customer, openAppointments, manicuristNameById, onClear, onDelete,
}: {
  customer: Customer;
  openAppointments: import('../../types').Appointment[];
  manicuristNameById: Map<string, string>;
  onClear: () => void;
  onDelete: (apptId: string) => void;
}) {
  // Build a self-contained printable HTML page and open it in a new window
  // so the salon can hand the client a paper schedule of their upcoming
  // visits. window.print() runs onload; nothing in the parent tab is
  // affected. If the popup is blocked, fall back to opening the same page
  // in the current tab via data: URL — the receptionist can ⌘P from there.
  function handlePrint() {
    const fmtDate = (iso: string) =>
      new Date(iso + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });
    const fmtTime = (t: string) => {
      const [hh, mm] = (t || '').split(':').map((s) => parseInt(s, 10));
      if (!Number.isFinite(hh)) return t;
      const ampm = hh >= 12 ? 'PM' : 'AM';
      const h12 = ((hh + 11) % 12) + 1;
      return `${h12}:${String(mm ?? 0).padStart(2, '0')} ${ampm}`;
    };
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = openAppointments
      .map((a) => {
        const services = (a.services?.length ? a.services : [a.service]).join(', ');
        const staffId = a.manicuristId ?? a.serviceRequests?.[0]?.manicuristIds?.[0] ?? null;
        const staff = staffId ? manicuristNameById.get(staffId) ?? '—' : '—';
        return `<tr>
          <td>${esc(fmtDate(a.date))}</td>
          <td>${esc(fmtTime(a.time))}</td>
          <td>${esc(services || '—')}</td>
          <td>${esc(staff)}</td>
        </tr>`;
      })
      .join('');
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Upcoming Appointments — ${esc(displayCustomerName(customer))}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; color: #111827; }
  h1 { font-size: 22px; margin: 0 0 4px 0; }
  .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #6b7280; border-bottom: 2px solid #111827; padding: 8px 6px; }
  td { padding: 10px 6px; border-bottom: 1px solid #e5e7eb; }
  tr:last-child td { border-bottom: 0; }
  .empty { color: #9ca3af; font-style: italic; padding: 24px 0; }
  @media print { body { padding: 16px; } }
</style></head>
<body>
<h1>${esc(displayCustomerName(customer))}</h1>
<div class="meta">${esc(customer.phone || 'no phone on file')} · ${openAppointments.length} upcoming appointment${openAppointments.length === 1 ? '' : 's'}</div>
${rows
  ? `<table><thead><tr><th>Date</th><th>Time</th><th>Services</th><th>Staff</th></tr></thead><tbody>${rows}</tbody></table>`
  : '<div class="empty">No upcoming appointments.</div>'}
<script>window.addEventListener('load', () => { setTimeout(() => window.print(), 100); });</script>
</body></html>`;
    const win = window.open('', '_blank', 'noopener,noreferrer,width=720,height=900');
    if (!win) {
      // Popup blocked — fall back to a data URL the user can print from.
      window.open('data:text/html;charset=utf-8,' + encodeURIComponent(html), '_blank');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }
  function formatDate(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    }).format(d);
  }
  function formatTime(t: string): string {
    const [hh, mm] = (t || '').split(':').map((s) => parseInt(s, 10));
    if (!Number.isFinite(hh)) return t;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${String(mm ?? 0).padStart(2, '0')} ${ampm}`;
  }
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] tracking-wider font-bold text-emerald-700 uppercase">
            Matched profile
          </p>
          <p className="font-mono text-sm font-semibold text-gray-900 truncate">
            {displayCustomerName(customer)}
          </p>
          <p className="font-mono text-xs text-gray-500">
            {customer.phone || 'no phone'} · {openAppointments.length} open appointment{openAppointments.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <button
            type="button"
            onClick={onClear}
            className="font-mono text-[10px] tracking-wider font-bold text-gray-500 hover:text-gray-800 uppercase"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={handlePrint}
            disabled={openAppointments.length === 0}
            title={openAppointments.length === 0 ? 'No upcoming appointments to print' : 'Print upcoming appointments'}
            aria-label="Print upcoming appointments"
            className="flex items-center justify-center w-7 h-7 rounded-md text-emerald-700 hover:text-emerald-900 hover:bg-emerald-100 disabled:text-gray-300 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            <Printer size={14} />
          </button>
        </div>
      </div>
      {openAppointments.length > 0 && (
        <div className="rounded-lg bg-white border border-emerald-100 overflow-hidden">
          <div className="grid grid-cols-[100px_70px_1fr_1fr_28px] gap-2 px-3 py-1.5 bg-emerald-50/60 border-b border-emerald-100 font-mono text-[10px] tracking-wider font-semibold text-emerald-700 uppercase">
            <span>Date</span>
            <span>Time</span>
            <span>Services</span>
            <span>Staff</span>
            <span aria-hidden="true" />
          </div>
          {openAppointments.slice(0, 5).map((a) => {
            const services = (a.services?.length ? a.services : [a.service]).join(', ');
            const staffId = a.manicuristId ?? a.serviceRequests?.[0]?.manicuristIds?.[0] ?? null;
            const staff = staffId ? manicuristNameById.get(staffId) ?? '—' : '—';
            return (
              <div
                key={a.id}
                className="grid grid-cols-[100px_70px_1fr_1fr_28px] gap-2 px-3 py-2 border-b border-emerald-50 last:border-b-0 items-center"
              >
                <span className="font-mono text-xs text-gray-800">{formatDate(a.date)}</span>
                <span className="font-mono text-xs text-gray-700">{formatTime(a.time)}</span>
                <span className="font-mono text-xs text-gray-700 truncate">{services || '—'}</span>
                <span className="font-mono text-xs text-gray-700 truncate">{staff}</span>
                <button
                  type="button"
                  onClick={() => onDelete(a.id)}
                  title="Delete this appointment"
                  aria-label="Delete appointment"
                  className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
          {openAppointments.length > 5 && (
            <p className="font-mono text-[10px] text-gray-400 px-3 py-1 text-center">
              Showing 5 of {openAppointments.length}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Booking recap ────────────────────────────────────────────────────────────

function BookingRecapModal({
  info, onClose, onEdit,
}: {
  info: {
    appointmentId: string;
    clientName: string;
    services: string[];
    date: string;
    time: string;
    staffName: string;
    serviceLines: Array<{ service: string; staffName: string }>;
    receptionistName: string;
    seriesDates?: string[];
    skippedDates?: string[];
    conflictDates?: string[];
    pendingAppts: Appointment[];
    pendingCustomer: {
      firstName: string;
      lastName: string;
      phone: string;
      notes: string;
      permanentNote: boolean;
    };
  };
  onClose: () => void;
  onEdit: () => void;
}) {
  function formatDate(iso: string): string {
    const d = new Date(iso + 'T12:00:00');
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    }).format(d);
  }
  function formatTime(t: string): string {
    const [hh, mm] = (t || '').split(':').map((s) => parseInt(s, 10));
    if (!Number.isFinite(hh)) return t;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${String(mm ?? 0).padStart(2, '0')} ${ampm}`;
  }
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 flex flex-col gap-4">
        <div>
          <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">BOOKING CONFIRMED</h2>
          <p className="font-mono text-xs text-gray-500 mt-0.5">Recap of what was just saved.</p>
        </div>
        <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4 flex flex-col gap-1.5">
          <RecapLine label="Client" value={info.clientName || 'Walk-in'} />
          <RecapLine label="When" value={`${formatDate(info.date)} · ${formatTime(info.time)}`} />
          {/* One line per service so multi-staff bookings name every
              manicurist involved. Each row: "<Service> -- <Staff>". */}
          <div className="flex items-start justify-between gap-3 pt-1">
            <span className="font-mono text-base uppercase tracking-wider text-gray-500 flex-shrink-0">With</span>
            <ul className="flex flex-col gap-0.5 text-right max-w-[70%]">
              {info.serviceLines.length === 0 ? (
                <li className="font-mono text-base font-semibold text-gray-900">{info.staffName || '\u2014'}</li>
              ) : info.serviceLines.map((sl, i) => (
                <li key={i} className="font-mono text-base font-semibold text-gray-900">
                  {sl.service} \u2014 <span className="text-emerald-700">{sl.staffName}</span>
                </li>
              ))}
            </ul>
          </div>
          <RecapLine label="Booked by" value={info.receptionistName || '\u2014'} />
        </div>
        {info.seriesDates && info.seriesDates.length > 0 && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 flex flex-col gap-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-indigo-700 font-bold">
              Standing series \u2014 {info.seriesDates.length} extra visit{info.seriesDates.length === 1 ? '' : 's'} booked
            </p>
            <ul className="flex flex-col gap-0.5">
              {info.seriesDates.map((d) => (
                <li key={d} className="font-mono text-xs text-indigo-900">{formatDate(d)}</li>
              ))}
            </ul>
          </div>
        )}
        {info.skippedDates && info.skippedDates.length > 0 && (
          <div className="rounded-xl border border-red-200 bg-red-50/50 p-4 flex flex-col gap-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-red-700 font-bold">
              {info.skippedDates.length} date{info.skippedDates.length === 1 ? '' : 's'} skipped \u2014 calendar blocked
            </p>
            <ul className="flex flex-col gap-0.5">
              {info.skippedDates.map((d) => (
                <li key={d} className="font-mono text-xs text-red-700">{formatDate(d)}</li>
              ))}
            </ul>
            <p className="font-mono text-[10px] text-red-500 mt-1">
              These weren't booked. Open the Calendar tab to unblock the day or pick a new date manually.
            </p>
          </div>
        )}
        {info.conflictDates && info.conflictDates.length > 0 && (
          <div className="rounded-xl border border-amber-300 bg-amber-50/60 p-4 flex flex-col gap-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-amber-800 font-bold">
              {info.conflictDates.length} date{info.conflictDates.length === 1 ? '' : 's'} unavailable \u2014 slot already booked
            </p>
            <ul className="flex flex-col gap-0.5">
              {info.conflictDates.map((d) => (
                <li key={d} className="font-mono text-xs text-amber-800">{formatDate(d)}</li>
              ))}
            </ul>
            <p className="font-mono text-[10px] text-amber-700 mt-1">
              The assigned staff already has an appointment at this time on these dates. Rebook them manually for a different time, or move the conflicting appt.
            </p>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="px-4 py-2 rounded-lg bg-white border border-gray-300 text-gray-700 font-mono text-xs font-bold hover:bg-gray-50"
          >
            EDIT
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800"
          >
            DONE
          </button>
        </div>
      </div>
    </div>
  );
}

function RecapLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500 flex-shrink-0">{label}</span>
      <span className="font-mono text-sm font-semibold text-gray-900 text-right truncate">{value}</span>
    </div>
  );
}
