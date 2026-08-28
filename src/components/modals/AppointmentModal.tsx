import { useState, useEffect, useMemo, useRef } from 'react';
import { X, ChevronDown, ChevronUp, Trash2, Printer, Calendar, History, Receipt, GripHorizontal } from 'lucide-react';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import CustomerNoteAlert from '../shared/CustomerNoteAlert';
import UpcomingApptsAlert from '../shared/UpcomingApptsAlert';
import DatePickerPopover from '../shared/DatePickerPopover';
import { useApp } from '../../state/AppContext';
import { supabase } from '../../lib/supabase';
import { formatMoneyCents } from '../../lib/tickets';
import {
  upsertCustomerFromIntake, toTitleCase, formatPhoneDashed,
  searchCustomers, displayCustomerName, normalizePhone, matchAppointments,
  appointmentStaffLabel,
} from '../../lib/customers';
import type { Customer } from '../../types';
import { SERVICE_CATEGORIES } from '../../constants/services';
import { getTodayLA } from '../../utils/time';
import { dedupeClientName } from '../../utils/clientNaming';
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
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const draft = mode === 'add' ? state.appointmentDraft : null;


  // Customer match suggestions surfaced while the receptionist types name
  // or phone. Clicking one fills the form and pins the matched profile.
  const [matches, setMatches] = useState<Customer[]>([]);
  const [matchedCustomer, setMatchedCustomer] = useState<Customer | null>(null);
  // Permanent-note popup — surfaced the moment a customer with a saved note
  // is matched (dropdown pick in add mode, phone lookup in edit mode), so
  // staff see it before finishing the booking instead of it just quietly
  // pre-filling the NOTES textarea further down the form where it's easy to
  // miss (Tony 2026-07-27: notes were getting silently skipped).
  const [noteAlert, setNoteAlert] = useState<{ name: string; note: string } | null>(null);
  // Upcoming-appointments popup — fires when the receptionist matches a
  // customer while starting a NEW booking and that person already has future
  // appointments on the books. The MatchedCustomerBanner below lists the same
  // rows, but it scrolls out of view on a long form and was being missed, so
  // the salon ended up double-booked when the client actually wanted the
  // EXISTING appointment moved. Same "surface it where it can't be missed"
  // reasoning as noteAlert above.
  const [apptsAlert, setApptsAlert] = useState<
    { name: string; appts: Appointment[] } | null
  >(null);
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

  // Debounced live search for existing customer profiles. Pass first/last/phone
  // separately so the search can require BOTH names to match when both are
  // typed ("Ju" + "Li" → Julie, closest on top) and avoid first-name clutter on
  // a last-name lookup.
  useEffect(() => {
    const fn = clientFirstName.trim();
    const ln = clientLastName.trim();
    const ph = clientPhone.trim();
    if (!fn && !ln && normalizePhone(ph).length < 3) { setMatches([]); return; }
    let cancelled = false;
    const handle = setTimeout(async () => {
      const rows = await searchCustomers({ first: fn, last: ln, phone: ph }, 6);
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

  // Pop the note alert the moment a DIFFERENT matched customer carries a
  // saved permanent note — keyed on id (not the object) so re-renders of the
  // same match don't re-trigger it, but clearing and re-picking the same
  // customer does. Covers both the add-mode dropdown pick and the edit-mode
  // phone lookup.
  useEffect(() => {
    if (!matchedCustomer) return;
    const stored = (matchedCustomer.notes ?? '').trim();
    if (!stored) return;
    setNoteAlert({ name: displayCustomerName(matchedCustomer), note: stored });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedCustomer?.id]);

  // Pop the upcoming-appointments alert on the same trigger as the note alert
  // (a newly matched customer id), but only while BOOKING — in edit mode the
  // receptionist is already looking at one of these rows, so interrupting them
  // with a list containing it would be noise.
  //
  // "Upcoming" is deliberately date-gated to today-or-later. A `scheduled` row
  // dated last month is a no-show nobody closed out, and letting those fire the
  // popup on every booking is how a warning turns into a reflex click-through.
  // Today's own overdue appointments still count — those are exactly the case
  // where the client is standing at the counter (cf. the assign-list overdue
  // bug, where filtering past deltas HID a live appointment).
  useEffect(() => {
    if (mode !== 'add') return;
    if (!matchedCustomer) return;
    const upcoming = matchAppointments(matchedCustomer, state.appointments)
      .filter((a) => (a.status === 'scheduled' || a.status === 'checked-in') && a.date >= today)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    if (upcoming.length === 0) return;
    setApptsAlert({ name: displayCustomerName(matchedCustomer), appts: upcoming });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedCustomer?.id]);

  // EDIT on a popup row: abandon the half-typed new booking and switch this
  // modal over to editing the appointment they picked. The receptionist already
  // cleared the PIN gate to open the booking modal, so carry that same identity
  // through as the editor rather than re-prompting — SET_APPOINTMENT_DRAFT
  // replaces the add-draft wholesale, matching what AppointmentsScreen does
  // when it opens an appointment for edit.
  function openApptForEdit(appointmentId: string) {
    const receptionistId = state.appointmentDraft?.bookedByReceptionistId ?? null;
    setApptsAlert(null);
    dispatch({ type: 'SET_APPOINTMENT_DRAFT', draft: { editingReceptionistId: receptionistId } });
    dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId });
    dispatch({ type: 'SET_MODAL', modal: 'editAppointment' });
  }
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
        searchCustomers({ phone: _phoneForLookup }, 5).then((rows) => {
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

    // Removing a service that is already being performed — or already finished
    // and credited — takes its block off the appointment book while the work
    // is still real. Tell the receptionist what it costs instead of discarding
    // it silently. (Desiree Reyna x SAM, 2026-08-13: Gel Fill was removed from
    // the booking at 23:58 while Sam was mid-service; he completed it at 00:28
    // but the block had already vanished from his column, and nobody noticed
    // until the next day.)
    //
    // The reducer enforces the same rule as a hard invariant
    // (retainBackedServices), which is what protects against silent/automated
    // writes. This dialog is the human's escape hatch: confirming here sets
    // `allowDroppingBackedServices` so a deliberate removal still goes
    // through instead of being mysteriously reverted.
    let allowDroppingBackedServices = false;
    if (mode === 'edit' && editing) {
      // Count-aware diff: which occurrences of which services are being dropped?
      const remaining = [...services];
      const dropped: string[] = [];
      for (const prev of editing.services ?? []) {
        const i = remaining.indexOf(prev);
        if (i >= 0) remaining.splice(i, 1);
        else dropped.push(prev);
      }
      if (dropped.length > 0) {
        const backedBy = new Map<string, Set<string>>();
        const note = (svc: string, who: string | undefined) => {
          if (!dropped.includes(svc)) return;
          const set = backedBy.get(svc) ?? new Set<string>();
          if (who) set.add(who);
          backedBy.set(svc, set);
        };
        for (const q of state.queue) {
          if (q.originalAppointment?.id !== editing.id) continue;
          const who = state.manicurists.find((m) => m.id === q.assignedManicuristId)?.name;
          for (const s of q.services ?? []) note(s, who);
        }
        for (const c of state.completed) {
          if (c.originalAppointmentId !== editing.id || c.voided) continue;
          for (const s of c.services ?? []) note(s, c.manicuristName);
        }
        if (backedBy.size > 0) {
          const lines = Array.from(backedBy.entries()).map(([svc, who]) =>
            who.size > 0 ? `  • ${svc} — ${Array.from(who).join(', ')}` : `  • ${svc}`,
          );
          const plural = backedBy.size > 1;
          const ok = window.confirm(
            `This appointment already has work on the floor for:\n\n${lines.join('\n')}\n\n` +
            `Removing ${plural ? 'these services' : 'this service'} here takes ` +
            `${plural ? 'their blocks' : 'the block'} off the appointment book. The work ` +
            `itself and any ticket lines are NOT removed — the service stays on the ticket ` +
            `and the manicurist keeps the turn credit.\n\n` +
            `Remove ${plural ? 'them' : 'it'} from the booking anyway?`,
          );
          if (!ok) return;
          allowDroppingBackedServices = true;
        }
      }
    }

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

    // SAFEGUARD: guarantee the appointment's anchor manicurist actually has a
    // column placement in serviceRequests. A same-time multi-service booking
    // can store its anchor only in the top-level manicuristId, with no matching
    // serviceRequests entry (the book renders that occurrence from manicuristId).
    // When such an appointment is edited — e.g. the receptionist shortens a
    // service's duration — the loop above can mint a placeholder entry with an
    // empty manicuristIds, orphaning that occurrence so it vanishes from the
    // appt book (the register is unaffected: it reads ticket_items separately).
    // If the anchor isn't represented in any entry, drop it into the first empty
    // slot so the column placement survives the edit.
    if (
      appointmentManicuristId &&
      serviceRequests.length > 0 &&
      !serviceRequests.some((r) => r.manicuristIds?.includes(appointmentManicuristId))
    ) {
      const orphan = serviceRequests.find((r) => !r.manicuristIds || r.manicuristIds.length === 0);
      if (orphan) orphan.manicuristIds = [appointmentManicuristId];
    }

    // Auto-number a duplicate name so two different people with the same first
    // name stay distinguishable in the book (we usually don't store last names).
    // Only for NEW bookings — editing keeps the typed name as-is. Collide
    // against other active appointments on the SAME date, plus anyone already
    // in the salon when the booking is for today.
    const rawName = clientName.trim() || 'Walk-in';
    let name = rawName;
    if (mode === 'add') {
      const sameDayApptNames = state.appointments
        .filter((a) =>
          a.id !== editing?.id &&
          a.date === date &&
          a.status !== 'cancelled' &&
          a.status !== 'no-show',
        )
        .map((a) => a.clientName);
      const floorNames = date === getTodayLA()
        ? [
            ...state.queue.map((q) => q.clientName),
            ...state.completed.filter((c) => !c.voided).map((c) => c.clientName),
          ]
        : [];
      name = dedupeClientName(rawName, [...sameDayApptNames, ...floorNames]);
    }

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
        // Only ever true when the receptionist was shown the on-the-floor
        // work above and explicitly confirmed the removal.
        allowDroppingBackedServices,
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
      // Name a tech ONLY for a client request. requestedManicuristIds is
      // populated only when clientRequest is true (see where serviceRequests is
      // built below, and the reload at ~424), so a non-empty list IS the
      // request test.
      //
      // The old `?? appointmentManicuristId` fallback is why this was wrong: a
      // non-request line still gets a column placement — auto-assigned, or
      // picked by the receptionist — but that placement is not a promise. The
      // queue hands the client to whoever is free, and stripping manicuristIds
      // from non-request entries is exactly what the book already does on the
      // way to the queue. Naming that tech in the recap read as a commitment
      // the booking never made (Tony 2026-08-28).
      const serviceLines = selectedServices.map((s) => {
        const mId = s.requestedManicuristIds[0] ?? null;
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
      // Show the staged booking as ghost blocks in the book behind the confirm
      // bar, on the day it lands, so the receptionist verifies the real slot —
      // right column, right time — instead of re-reading the same form values
      // she just typed. Still nothing saved: these are render-only until
      // CONFIRM (see the Kayla Nguyen note on the recap payload above).
      dispatch({ type: 'SET_PENDING_APPOINTMENT_PREVIEW', appointments: pendingAppts });
      moveBookToDate(date);
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

  // Move the appointment book behind this modal to whatever date was just
  // picked. Booking against a date the book ISN'T showing is how appointments
  // land on the wrong day: the receptionist reads availability off the grid in
  // front of her while the form quietly holds a different date. Keeping the two
  // in step means the columns she is looking at are the columns she is booking
  // into.
  //
  // Rides on appointmentDraft.date, which AppointmentsScreen already seeds from
  // its own selectedDate when it opens this modal — so this closes that loop
  // rather than adding a second source of truth. The rest of the draft is
  // spread through untouched: it carries bookedByReceptionistId, which becomes
  // the booking's audit trail.
  //
  // Add mode only. In edit mode the book jumping around while someone corrects
  // a typo on an existing appointment would be movement they didn't ask for.
  function moveBookToDate(d: string) {
    if (mode !== 'add') return;
    dispatch({
      type: 'SET_APPOINTMENT_DRAFT',
      draft: { ...(state.appointmentDraft ?? {}), date: d },
    });
  }

  function handleClose() {
    // Belt and braces: every exit clears the ghost blocks. Leaving a preview
    // behind would paint an appointment in the book that does not exist.
    dispatch({ type: 'SET_PENDING_APPOINTMENT_PREVIEW', appointments: null });
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

  // Confirm step: the form and its right-docked panel come off screen
  // entirely so the appointment book is visible, with the staged booking
  // showing as a ghost block in its real slot. Only the bottom bar remains.
  //
  // An early return, not a conditional inside the Modal, because the docked
  // panel covers the columns the receptionist needs to check. The component
  // stays mounted either way, so EDIT drops straight back into the form with
  // every input still intact.
  if (recap) {
    return (
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
            // The appointment is already dispatched above (intentionally
            // optimistic), but the customer profile + permanent-note write
            // here used to swallow errors with `void (async)()` and no catch.
            // The receptionist would see the booking land and never know
            // the note silently dropped. Surface a clear alert on failure so
            // they know to re-enter via Blueprint > Customers.
            // (2026-05-31 audit N31-H4)
            try {
              const cid = await upsertCustomerFromIntake({
                firstName: c.firstName,
                lastName: c.lastName,
                phone: c.phone,
              });
              if (cid && c.permanentNote) {
                const { error: noteErr } = await supabase
                  .from('customers')
                  .update({ notes: c.notes, updated_at: new Date().toISOString() })
                  .eq('id', cid);
                if (noteErr) throw noteErr;
              }
            } catch (err) {
              console.error('[AppointmentModal] customer save failed:', err);
              const msg = (err as { message?: string } | null)?.message ?? String(err);
              window.alert(
                `Appointment booked, but the customer profile / permanent note did not save:\n\n${msg}\n\nPlease re-enter the note via Blueprint > Customers.`,
              );
            }
          })();
          dispatch({ type: 'SET_PENDING_APPOINTMENT_PREVIEW', appointments: null });
          setRecap(null);
          handleClose();
        }}
        onEdit={() => {
          // EDIT: discard the staged booking and return to the form. The
          // form is still mounted with all the receptionist's inputs intact
          // — they can fix whatever was wrong and press BOOK again. Dropping
          // the preview here is what keeps a backed-out booking from leaving
          // anything behind, in the book or in the data.
          dispatch({ type: 'SET_PENDING_APPOINTMENT_PREVIEW', appointments: null });
          setRecap(null);
        }}
      />
    );
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
            <p className="font-mono text-xs tracking-wider font-bold text-pink-700 uppercase mb-1.5">
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
                  <span className="font-mono text-base font-semibold text-gray-900 truncate">
                    {displayCustomerName(c)}
                  </span>
                  <span className="font-mono text-base text-gray-500 flex-shrink-0">{c.phone || '—'}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Client info */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider mb-1.5">FIRST NAME</label>
            <input
              type="text"
              value={clientFirstName}
              onChange={(e) => setClientFirstName(e.target.value)}
              onBlur={(e) => setClientFirstName(toTitleCase(e.target.value))}
              placeholder="First"
              autoFocus={mode === 'add'}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-base text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider mb-1.5">LAST NAME</label>
            <input
              type="text"
              value={clientLastName}
              onChange={(e) => setClientLastName(e.target.value)}
              onBlur={(e) => setClientLastName(toTitleCase(e.target.value))}
              placeholder="Last"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-base text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider mb-1.5">PHONE</label>
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
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-base text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        {/* Services */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider">SERVICES</label>
          </div>

          <div className="flex gap-2 mb-3">
            <div className="flex-1">
              <select
                value={selectedCategory}
                onChange={(e) => { setSelectedCategory(e.target.value); setSelectedServiceId(''); }}
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-base text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer"
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
                className="w-full px-3 py-2.5 rounded-xl border border-gray-200 font-mono text-base text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all appearance-none cursor-pointer disabled:bg-gray-50 disabled:text-gray-300 disabled:cursor-not-allowed"
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
              <p className="font-mono text-base text-gray-400">No services added yet</p>
              <p className="font-mono text-sm text-gray-400 mt-1">Select a category and service above</p>
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
                          <p className="font-mono text-base font-semibold text-pink-700">{s.serviceName}</p>
                          {s.requestedManicuristIds.length > 0 && (
                            <span className="flex items-center gap-1">
                              <span className="px-1.5 py-0.5 rounded-md font-mono text-[10px] font-bold bg-pink-500 text-white leading-none tracking-wide">REQ</span>
                              <span className="font-mono text-sm text-pink-600 font-semibold">
                                {s.requestedManicuristIds.map((id) => state.manicurists.find((m) => m.id === id)?.name).filter(Boolean).join(', ')}
                              </span>
                            </span>
                          )}
                          {s.durationAdjustment !== 0 && (
                            <span
                              className={`px-1.5 py-0.5 rounded-md font-mono text-sm font-semibold leading-none ${
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
                          <p className="font-mono text-sm text-gray-500 font-semibold tracking-wider mb-2">
                            REQUEST MANICURIST <span className="text-gray-400 font-normal">(optional)</span>
                          </p>
                          <div className="flex flex-wrap gap-1.5">
                            {displayStaff.map((m) => {
                              const isSelected = s.requestedManicuristIds.includes(m.id);
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => toggleManicurist(idx, m.id)}
                                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-sm font-semibold transition-all ${
                                    isSelected ? 'bg-pink-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-pink-100 hover:text-pink-700'
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
                          <p className="font-mono text-sm text-gray-500 font-semibold tracking-wider mb-2">
                            DURATION ADJUSTMENT <span className="text-gray-400 font-normal">(optional)</span>
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => bumpDurationAdjustment(idx, -5)}
                              className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 font-mono text-base font-bold text-gray-600 transition-colors"
                            >
                              -
                            </button>
                            <span className={`font-mono text-base font-semibold w-14 text-center tabular-nums ${
                              s.durationAdjustment > 0 ? 'text-amber-600' :
                              s.durationAdjustment < 0 ? 'text-emerald-600' : 'text-gray-400'
                            }`}>
                              {s.durationAdjustment > 0 ? '+' : ''}{s.durationAdjustment}m
                            </span>
                            <button
                              type="button"
                              onClick={() => bumpDurationAdjustment(idx, 5)}
                              className="w-8 h-8 flex items-center justify-center rounded-lg bg-gray-100 hover:bg-gray-200 font-mono text-base font-bold text-gray-600 transition-colors"
                            >
                              +
                            </button>
                            <span className="font-mono text-sm text-gray-500 ml-2">
                              base {baseDuration}m &rarr; <span className="text-gray-600 font-semibold">{adjustedDuration}m</span>
                            </span>
                          </div>
                          <p className="font-mono text-sm text-gray-400 mt-1.5">
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
            <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider mb-1.5">DATE</label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setDatePickerOpen((v) => !v)}
                className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-base text-gray-900 text-left flex items-center justify-between gap-2 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
              >
                <span>
                  {date
                    ? new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                    : 'Pick a date'}
                </span>
                <Calendar size={16} className="text-pink-500 flex-shrink-0" />
              </button>
              {datePickerOpen && (
                <DatePickerPopover
                  value={date}
                  today={today}
                  onChange={(d) => { setDate(d); setDatePickerOpen(false); moveBookToDate(d); }}
                  onClose={() => setDatePickerOpen(false)}
                />
              )}
            </div>
          </div>
          <div>
            <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider mb-1.5">TIME</label>
            <input
              type="text"
              inputMode="numeric"
              value={timeRaw}
              onChange={(e) => setTimeRaw(e.target.value)}
              onBlur={commitTime}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitTime(); } }}
              placeholder="9:30 AM"
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-base text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        {/* Same-time / Party-group / Caution / Standing flags. Grid (not
            flex-wrap) so Standing is deterministically positioned right of
            Caution regardless of font size or panel width — flex-wrap would
            drop it to a new row once the labels got wide enough to overflow
            the row (Tony 2026-08-06). */}
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer hover:bg-gray-50 transition-colors select-none">
            <input
              type="checkbox"
              checked={sameTime}
              onChange={(e) => setSameTime(e.target.checked)}
              className="w-4 h-4 accent-green-500"
            />
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-green-500 text-white font-bold text-xs">S</span>
            <span className="font-mono text-base text-gray-700">Same time</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer hover:bg-gray-50 transition-colors select-none">
            <input
              type="checkbox"
              checked={partyGroup}
              onChange={(e) => setPartyGroup(e.target.checked)}
              className="w-4 h-4 accent-purple-500"
            />
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-purple-500 text-white font-bold text-xs">P</span>
            <span className="font-mono text-base text-gray-700">Party group</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-gray-200 bg-white cursor-pointer hover:bg-gray-50 transition-colors select-none">
            <input
              type="checkbox"
              checked={caution}
              onChange={(e) => setCaution(e.target.checked)}
              className="w-4 h-4 accent-amber-500"
            />
            <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 text-white font-bold text-xs">C</span>
            <span className="font-mono text-base text-gray-700">Caution</span>
          </label>
          {mode === 'add' && (
            <label
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border cursor-pointer transition-colors select-none ${
                isStandingAppt ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50'
              }`}
            >
              <input
                type="checkbox"
                checked={isStandingAppt}
                onChange={(e) => setIsStandingAppt(e.target.checked)}
                className="w-4 h-4 accent-indigo-500"
              />
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-indigo-500 text-white font-bold text-xs">R</span>
              <span className="font-mono text-base text-indigo-800">Standing</span>
            </label>
          )}
        </div>

        {/* Standing appointment detail — recurring cadence. Only rendered once
            the Standing pill above is checked, instead of always showing the
            full panel (Tony 2026-08-06: collapse it into the pill row). */}
        {mode === 'add' && isStandingAppt && (
          <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-3 space-y-3">
            <p className="font-mono text-sm text-indigo-600">Repeat this booking on a fixed cadence</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider mb-1.5">EVERY (DAYS)</label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={standingIntervalDays}
                  onChange={(e) => setStandingIntervalDays(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 font-mono text-base text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
                />
              </div>
              <div>
                <label className="block font-mono text-sm text-gray-500 font-semibold tracking-wider mb-1.5">BOOK THROUGH</label>
                <input
                  type="date"
                  value={standingEndDate}
                  min={date}
                  onChange={(e) => setStandingEndDate(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 font-mono text-base text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-200 focus:border-indigo-300 transition-all"
                />
              </div>
            </div>
          </div>
        )}

        {/* Notes */}
        <div>
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <label className="font-mono text-sm text-gray-500 font-semibold tracking-wider">NOTES</label>
            <label
              className="inline-flex items-center gap-1.5 cursor-pointer select-none"
              title="Auto-loads on future bookings for this customer"
            >
              <input
                type="checkbox"
                checked={permanentNote}
                onChange={(e) => setPermanentNote(e.target.checked)}
                className="w-4 h-4 accent-pink-500"
              />
              <span className="font-mono text-sm text-gray-500">Save as permanent note</span>
            </label>
          </div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any special requests..."
            rows={2}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-base text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all resize-none"
          />
        </div>

        {mode === 'edit' ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowCancelConfirm(true)}
              className="px-4 py-3 rounded-xl bg-white border-2 border-red-200 text-red-600 font-mono text-base font-semibold hover:bg-red-50 hover:border-red-300 active:scale-[0.98] transition-all"
            >
              CANCEL APPT
            </button>
            <button
              type="submit"
              disabled={selectedServices.length === 0}
              className="flex-1 py-3 rounded-xl bg-pink-500 text-white font-mono text-base font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
            >
              SAVE CHANGES
            </button>
          </div>
        ) : (
          <button
            type="submit"
            disabled={selectedServices.length === 0}
            className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-base font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
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
    {noteAlert && (
      <CustomerNoteAlert
        name={noteAlert.name}
        note={noteAlert.note}
        onDismiss={() => setNoteAlert(null)}
      />
    )}
    {/* Queued behind the note alert rather than stacked on top of it — both
        fire off the same matched-customer id, and two overlapping popups is
        how the second one gets dismissed unread. */}
    {apptsAlert && !noteAlert && (
      <UpcomingApptsAlert
        name={apptsAlert.name}
        appointments={apptsAlert.appts}
        manicuristNameById={new Map(state.manicurists.map((m) => [m.id, m.name]))}
        onEdit={openApptForEdit}
        onNew={() => setApptsAlert(null)}
      />
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
  // ── Previous-services history ────────────────────────────────────────────
  // Lazy-loaded the first time the receptionist opens it. Tickets carry no
  // phone (always blank) and the salon disambiguates same-name clients with a
  // numeric suffix in the NAME itself ("Jennifer 2"), so a client's past
  // visits are matched by exact (case-insensitive) name.
  type HistItem = { name: string; staff: string | null; kind: string; qty: number; extCents: number | null };
  type HistVisit = {
    ticketId: string;
    ticketNumber: number | null;
    date: string;
    services: string[];
    staff: string[];
    items: HistItem[];
    subtotalCents: number | null;
    discountCents: number | null;
    taxCents: number | null;
    tipCents: number | null;
    totalCents: number | null;
  };
  const [showHistory, setShowHistory] = useState(false);
  const [historyRows, setHistoryRows] = useState<HistVisit[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewVisit, setViewVisit] = useState<HistVisit | null>(null);

  async function toggleHistory() {
    if (historyRows !== null) { setShowHistory((v) => !v); return; }
    setShowHistory(true);
    setHistoryLoading(true);
    try {
      const name = displayCustomerName(customer).trim();
      const { data, error } = await supabase
        .from('tickets')
        .select('id, ticket_number, business_date, status, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, ticket_items(name, staff1_name, kind, quantity, ext_price_cents, sort_order)')
        .ilike('client_name', name)
        .neq('status', 'voided')
        .order('business_date', { ascending: false })
        .limit(60);
      if (error) throw error;
      type TI = { name: string; staff1_name: string | null; kind: string; quantity: number | null; ext_price_cents: number | null; sort_order: number | null };
      type TRow = {
        id: string; ticket_number: number | null; business_date: string;
        subtotal_cents: number | null; discount_cents: number | null; tax_cents: number | null;
        tip_cents: number | null; total_cents: number | null; ticket_items?: TI[];
      };
      const rows = (data ?? [])
        .map((t) => {
          const tt = t as TRow;
          const items = (tt.ticket_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
          const serviceItems = items.filter((i) => i.kind === 'service');
          return {
            ticketId: tt.id,
            ticketNumber: tt.ticket_number,
            date: tt.business_date,
            services: serviceItems.map((i) => i.name),
            staff: Array.from(new Set(serviceItems.map((i) => i.staff1_name).filter((s): s is string => !!s))),
            items: items.map((i) => ({ name: i.name, staff: i.staff1_name, kind: i.kind, qty: i.quantity ?? 1, extCents: i.ext_price_cents })),
            subtotalCents: tt.subtotal_cents,
            discountCents: tt.discount_cents,
            taxCents: tt.tax_cents,
            tipCents: tt.tip_cents,
            totalCents: tt.total_cents,
          } as HistVisit;
        })
        .filter((r) => r.services.length > 0);
      setHistoryRows(rows);
    } catch (e) {
      console.warn('[appt] client history load failed', e);
      setHistoryRows([]);
    } finally {
      setHistoryLoading(false);
    }
  }

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
        // All techs, not just the first — this sheet goes home with the
        // client, so dropping the second one is the worst place to do it.
        const staff = appointmentStaffLabel(a, manicuristNameById);
        return `<tr>
          <td>${esc(fmtDate(a.date))}</td>
          <td>${esc(fmtTime(a.time))}</td>
          <td>${esc(services || '—')}</td>
          <td>${esc(staff)}</td>
        </tr>`;
      })
      .join('');
    // Same salon branding as the register receipt (printReceipt.ts) — the
    // AQUA nails bar logo lives in public/AQUA_logo_FINAL.jpg. Falls back to
    // text if the image fails to load.
    const LOGO_URL = '/AQUA_logo_FINAL.jpg';
    const html = `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Upcoming Appointments — ${esc(displayCustomerName(customer))}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 32px; color: #111827; }
  .logo { text-align: center; margin: 0 0 16px; }
  .logo img { max-height: 110px; max-width: 90%; display: inline-block; }
  .salon, .salon-sub { display: none; text-align: center; }
  .show-fallback .salon { display: block; font-size: 1.6rem; font-weight: bold; letter-spacing: 0.2em; color: #2dd4cc; }
  .show-fallback .salon-sub { display: block; font-size: 1rem; color: #555; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
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
<div class="logo"><img src="${LOGO_URL}" alt="AQUA" onerror="this.style.display='none'; document.body.classList.add('show-fallback');" /></div>
<div class="salon">AQUA</div>
<div class="salon-sub">nails bar</div>
<h1>${esc(displayCustomerName(customer))}</h1>
<div class="meta">${esc(customer.phone || 'no phone on file')} · ${openAppointments.length} upcoming appointment${openAppointments.length === 1 ? '' : 's'}</div>
${rows
  ? `<table><thead><tr><th>Date</th><th>Time</th><th>Services</th><th>Staff</th></tr></thead><tbody>${rows}</tbody></table>`
  : '<div class="empty">No upcoming appointments.</div>'}
</body></html>`;
    // No noopener/noreferrer here — this window is blank same-origin content
    // we immediately fill via document.write below, not a link to a
    // third-party site, so there's no opener/referrer to protect against.
    // Passing noopener made window.open() ALWAYS return null (per spec, a
    // noopener'd window has no WindowProxy to hand back), which meant every
    // print attempt fell into the "popup blocked" fallback below — a giant
    // data: URL that Chrome renders as a blank page. Removing it lets the
    // normal path succeed and reserves the fallback for genuine popup blocks.
    const win = window.open('', '_blank', 'width=720,height=900');
    if (!win) {
      // Popup actually blocked — fall back to a data URL the user can print from.
      window.open('data:text/html;charset=utf-8,' + encodeURIComponent(html), '_blank');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    // Wait for the logo image to load (or fail) before firing the print
    // dialog so it's actually included in the printed output — mirrors
    // printReceipt.ts. Falls back to a safety timer in case the load event
    // never fires (e.g. the image is already cached).
    let printed = false;
    const doPrint = () => {
      if (printed) return;
      printed = true;
      win.focus();
      win.print();
    };
    win.addEventListener('load', () => setTimeout(doPrint, 100));
    setTimeout(doPrint, 600);
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
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={toggleHistory}
              title="View this client's previous services"
              aria-label="View previous services"
              className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors ${showHistory ? 'text-emerald-900 bg-emerald-100' : 'text-emerald-700 hover:text-emerald-900 hover:bg-emerald-100'}`}
            >
              <History size={14} />
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
            const staff = appointmentStaffLabel(a, manicuristNameById);
            return (
              <div
                key={a.id}
                className="grid grid-cols-[100px_70px_1fr_1fr_28px] gap-2 px-3 py-2 border-b border-emerald-50 last:border-b-0 items-center"
              >
                <span className="font-mono text-xs text-gray-800">{formatDate(a.date)}</span>
                <span className="font-mono text-xs text-gray-700">{formatTime(a.time)}</span>
                {/* Both truncate in this narrow docked panel — the title
                    attribute is the only way to read a long service list or a
                    three-tech booking without opening the appointment. */}
                <span className="font-mono text-xs text-gray-700 truncate" title={services || '—'}>{services || '—'}</span>
                <span className="font-mono text-xs text-gray-700 truncate" title={staff}>{staff}</span>
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
      {showHistory && (
        <div className="rounded-lg bg-white border border-emerald-100 overflow-hidden">
          <div className="px-3 py-1.5 bg-emerald-50/60 border-b border-emerald-100 font-mono text-[10px] tracking-wider font-semibold text-emerald-700 uppercase">
            Previous services
          </div>
          {historyLoading && (
            <p className="font-mono text-[11px] text-gray-400 px-3 py-3 text-center">Loading history…</p>
          )}
          {!historyLoading && historyRows && historyRows.length === 0 && (
            <p className="font-mono text-[11px] text-gray-400 px-3 py-3 text-center">No previous services on file.</p>
          )}
          {!historyLoading && historyRows && historyRows.length > 0 && (
            <div className="grid grid-cols-[84px_1fr_1fr_28px] gap-2 px-3 py-1.5 bg-emerald-50/40 border-b border-emerald-100 font-mono text-[10px] tracking-wider font-semibold text-emerald-700/80 uppercase">
              <span>Date</span>
              <span>Services</span>
              <span>Staff</span>
              <span aria-hidden="true" />
            </div>
          )}
          {!historyLoading && historyRows && historyRows.slice(0, 20).map((r, i) => (
            <div
              key={`${r.ticketId}-${i}`}
              className="grid grid-cols-[84px_1fr_1fr_28px] gap-2 px-3 py-2 border-b border-emerald-50 last:border-b-0 items-center"
            >
              <span className="font-mono text-xs text-gray-800">{formatDate(r.date)}</span>
              <span className="font-mono text-xs text-gray-700">{r.services.join(', ') || '—'}</span>
              <span className="font-mono text-xs text-gray-700">{r.staff.join(', ') || '—'}</span>
              <button
                type="button"
                onClick={() => setViewVisit(r)}
                title="View full ticket"
                aria-label="View full ticket"
                className="flex items-center justify-center w-7 h-7 rounded-md text-gray-400 hover:text-emerald-700 hover:bg-emerald-50 transition-colors"
              >
                <Receipt size={14} />
              </button>
            </div>
          ))}
          {!historyLoading && historyRows && historyRows.length > 20 && (
            <p className="font-mono text-[10px] text-gray-400 px-3 py-1 text-center">
              Showing 20 of {historyRows.length} visits
            </p>
          )}
        </div>
      )}
      {viewVisit && (
        <Modal
          title={viewVisit.ticketNumber ? `Ticket #${viewVisit.ticketNumber}` : 'Ticket'}
          onClose={() => setViewVisit(null)}
          width="max-w-md"
        >
          <div className="font-mono">
            <p className="text-xs text-gray-500 mb-3">
              {formatDate(viewVisit.date)} · {displayCustomerName(customer)}
            </p>
            <div className="border border-gray-100 rounded-lg overflow-hidden">
              {viewVisit.items.map((it, i) => (
                <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 border-b border-gray-50 last:border-b-0">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-900 truncate">{it.qty > 1 ? `${it.qty}× ` : ''}{it.name}</p>
                    {it.staff && <p className="text-[11px] text-gray-500">{it.staff}</p>}
                  </div>
                  <span className="text-sm text-gray-700 whitespace-nowrap">{it.extCents != null ? formatMoneyCents(it.extCents) : '—'}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-1 text-sm">
              {viewVisit.subtotalCents != null && (
                <div className="flex justify-between text-gray-600"><span>Subtotal</span><span>{formatMoneyCents(viewVisit.subtotalCents)}</span></div>
              )}
              {viewVisit.discountCents != null && viewVisit.discountCents > 0 && (
                <div className="flex justify-between text-gray-600"><span>Discount</span><span>−{formatMoneyCents(viewVisit.discountCents)}</span></div>
              )}
              {viewVisit.taxCents != null && viewVisit.taxCents > 0 && (
                <div className="flex justify-between text-gray-600"><span>Tax</span><span>{formatMoneyCents(viewVisit.taxCents)}</span></div>
              )}
              {viewVisit.tipCents != null && viewVisit.tipCents > 0 && (
                <div className="flex justify-between text-gray-600"><span>Tip</span><span>{formatMoneyCents(viewVisit.tipCents)}</span></div>
              )}
              {viewVisit.totalCents != null && (
                <div className="flex justify-between font-bold text-gray-900 pt-1 border-t border-gray-100"><span>Total</span><span>{formatMoneyCents(viewVisit.totalCents)}</span></div>
              )}
            </div>
          </div>
        </Modal>
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

  const panelRef = useRef<HTMLDivElement | null>(null);
  // null until the first drag — see the style prop for why centring stays in
  // CSS rather than being measured up front.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Grab offset within the panel, so it doesn't jump to put its corner under
  // the finger on the first move.
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    grabRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    // Freeze the CSS-centred position into real px before the first move, or
    // the translate(-50%,-50%) would fight the left/top we're about to set.
    setPos({ x: r.left, y: r.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onDrag(e: React.PointerEvent<HTMLDivElement>) {
    const grab = grabRef.current;
    const el = panelRef.current;
    if (!grab || !el) return;
    const r = el.getBoundingClientRect();
    // Clamp so the panel can never be stranded off screen: the handle stays on
    // screen vertically, and at least a strip of the panel stays grabbable
    // horizontally. Without this a hard flick could park CONFIRM somewhere
    // nobody can reach.
    const EDGE = 80;
    setPos({
      x: Math.min(Math.max(e.clientX - grab.dx, EDGE - r.width), window.innerWidth - EDGE),
      y: Math.min(Math.max(e.clientY - grab.dy, 0), window.innerHeight - 40),
    });
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    grabRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  // A centred floating panel that the receptionist can DRAG, and no dark
  // backdrop: the whole point of this step is to look at the ghost block now
  // sitting in the grid, so whatever the panel covers has to be movable out of
  // the way rather than dismissed (Tony 2026-08-28). It opens centred because
  // that is where the eye already is after pressing BOOK; the bottom bar it
  // replaced was easy to miss on a wide tablet.
  //
  // The heading is imperative, not past tense. The old card read "BOOKING
  // CONFIRMED — recap of what was just saved" while nothing had been saved yet
  // (the rows are only dispatched by the CONFIRM handler), so it claimed a
  // durable booking that a stray EDIT would have silently discarded.
  return (
    <div
      ref={panelRef}
      style={
        // null = "still centred", expressed as a transform so the panel needs
        // no measurement before first paint (no flash at 0,0). The first drag
        // freezes the measured position into px and takes over from here.
        pos
          ? { left: pos.x, top: pos.y }
          : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }
      }
      className="fixed z-[70] w-[min(760px,calc(100vw-1.5rem))] rounded-xl border-2 border-sky-300 bg-white shadow-[0_10px_40px_rgba(0,0,0,0.22)]"
    >
      {/* Drag handle. Pointer events (not mouse) so this works with a finger on
          the front-desk tablets; touch-none stops the browser panning the book
          instead of moving the panel. */}
      <div
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="flex items-center justify-center gap-2 rounded-t-lg border-b border-sky-200 bg-sky-50 px-5 py-2 cursor-grab active:cursor-grabbing touch-none select-none"
      >
        <GripHorizontal size={18} className="text-sky-500" />
        <span className="font-mono text-xs font-bold uppercase tracking-wider text-sky-700">
          Drag to move
        </span>
      </div>
      <div className="px-6 py-5 flex flex-col gap-4">
        {/* Warnings stay above the summary — a skipped or conflicting date is
            the whole reason to press EDIT instead of CONFIRM. */}
        {info.seriesDates && info.seriesDates.length > 0 && (
          <p className="font-mono text-base text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3 leading-relaxed">
            <span className="font-bold uppercase tracking-wider">Standing series</span>
            {' — '}{info.seriesDates.length} extra visit{info.seriesDates.length === 1 ? '' : 's'}:{' '}
            {info.seriesDates.map(formatDate).join(' · ')}
          </p>
        )}
        {info.skippedDates && info.skippedDates.length > 0 && (
          <p className="font-mono text-base text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-3 leading-relaxed">
            <span className="font-bold uppercase tracking-wider">
              {info.skippedDates.length} date{info.skippedDates.length === 1 ? '' : 's'} skipped
            </span>
            {' — calendar blocked: '}{info.skippedDates.map(formatDate).join(' · ')}.
            {' '}Not booked. Unblock the day in the Calendar tab, or pick a new date.
          </p>
        )}
        {info.conflictDates && info.conflictDates.length > 0 && (
          <p className="font-mono text-base text-amber-800 bg-amber-50 border border-amber-300 rounded-lg px-4 py-3 leading-relaxed">
            <span className="font-bold uppercase tracking-wider">
              {info.conflictDates.length} date{info.conflictDates.length === 1 ? '' : 's'} unavailable
            </span>
            {' — slot already booked: '}{info.conflictDates.map(formatDate).join(' · ')}.
            {' '}That staff member already has an appointment at this time.
          </p>
        )}

        {/* Summary above, buttons on their own row below. Side-by-side was a
            hangover from the full-width bottom bar; in a floating panel it left
            the text a cramped column beside the buttons. */}
        <div className="space-y-3">
          <div className="space-y-1.5">
            <h2 className="font-bebas text-4xl leading-tight tracking-[3px] text-gray-900">
              CONFIRM THIS BOOKING
            </h2>
            <p className="font-mono text-base leading-relaxed text-sky-700">
              Check the highlighted block in the book behind.
            </p>
          </div>

          {/* Separators are real elements with margin. They used to be
              `{'   ·   '}` inside a string — HTML collapses a run of spaces to
              one, so the padding that was meant to be there never rendered. */}
          <p className="font-mono text-xl font-semibold leading-relaxed text-gray-900">
            {info.clientName || 'Walk-in'}
            <span className="mx-3 text-gray-300">·</span>
            {formatDate(info.date)}
            <span className="mx-3 text-gray-300">·</span>
            {formatTime(info.time)}
          </p>

          {/* One element per service line, wrapping, instead of one joined and
              truncated string — a two-tech booking now reads as two entries
              rather than running together and being cut off. */}
          <ul className="flex flex-wrap gap-x-7 gap-y-2 font-mono text-lg leading-relaxed text-gray-600">
            {info.serviceLines.length === 0 ? (
              <li>{info.staffName || '—'}</li>
            ) : (
              info.serviceLines.map((sl, i) => (
                <li key={`${sl.service}-${sl.staffName}-${i}`}>
                  <span className="text-gray-900">{sl.service}</span>
                  <span className="mx-2 text-gray-300">—</span>
                  {sl.staffName}
                </li>
              ))
            )}
          </ul>

          {info.receptionistName && (
            <p className="font-mono text-base leading-relaxed text-gray-400">
              booked by {info.receptionistName}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-gray-100 pt-4">
          <button
            type="button"
            onClick={onEdit}
            className="px-7 py-3.5 rounded-lg bg-white border border-gray-300 text-gray-700 font-mono text-base font-bold tracking-wider hover:bg-gray-50"
          >
            EDIT
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-8 py-3.5 rounded-lg bg-sky-400 hover:bg-sky-500 text-white font-mono text-base font-bold tracking-wider transition-colors"
          >
            CONFIRM APPOINTMENT
          </button>
        </div>
      </div>
    </div>
  );
}
