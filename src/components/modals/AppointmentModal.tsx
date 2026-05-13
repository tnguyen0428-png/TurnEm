import { useState, useEffect, useMemo } from 'react';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import {
  upsertCustomerFromIntake, toTitleCase, formatPhoneDashed,
  searchCustomers, displayCustomerName, normalizePhone, matchAppointments,
} from '../../lib/customers';
import type { Customer } from '../../types';
import ReceptionistPinGate from '../shared/ReceptionistPinGate';
import { SERVICE_CATEGORIES } from '../../constants/services';
import { getTodayLA } from '../../utils/time';
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

export default function AppointmentModal({ mode }: AppointmentModalProps) {
  const { state, dispatch } = useApp();

  const editing = mode === 'edit'
    ? state.appointments.find((a) => a.id === state.editingAppointmentId)
    : null;

  const today = getTodayLA();
  const draft = mode === 'add' ? state.appointmentDraft : null;

  const [showBookGate, setShowBookGate] = useState(false);
  // Holds the parsed-and-validated form payload while the PIN gate is open.
  const [pendingBooking, setPendingBooking] = useState<null | {
    name: string;
    services: string[];
    serviceRequests: unknown[];
    appointmentManicuristId: string | null;
    partyId: string | null;
  }>(null);
  // Customer match suggestions surfaced while the receptionist types name
  // or phone. Clicking one fills the form and pins the matched profile.
  const [matches, setMatches] = useState<Customer[]>([]);
  const [matchedCustomer, setMatchedCustomer] = useState<Customer | null>(null);
  // Recap shown after a successful new booking — receptionist taps DONE
  // to dismiss. Edits skip this.
  const [recap, setRecap] = useState<null | {
    clientName: string;
    services: string[];
    date: string;
    time: string;
    staffName: string;
    receptionistName: string;
  }>(null);
  const [clientFirstName, setClientFirstName] = useState('');
  const [clientLastName, setClientLastName] = useState('');
  // Combined name used everywhere else in this modal (save payload, display).
  // The two inputs stay the single source of truth.
  const clientName = `${clientFirstName.trim()} ${clientLastName.trim()}`.trim();
  const [clientPhone, setClientPhone] = useState('');

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
  const [notes, setNotes] = useState('');
  const [sameTime, setSameTime] = useState(false);
  const [partyGroup, setPartyGroup] = useState(false);

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
      setSameTime(editing.sameTime || false);
      setPartyGroup(!!editing.partyId);

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

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedServices.length === 0) return;

    const services = selectedServices.map((s) => s.serviceName as ServiceType);

    // Build one entry per service occurrence — merges client request + existing placement/startTime.
    // This avoids duplicate entries that would confuse occurrence-based routing.
    const existingReqs = editing?.serviceRequests || [];
    // If the user explicitly changed the appointment time in the modal, drop all per-service
    // startTime overrides so the whole appointment moves to the new time instead of the
    // old per-service times overriding it.
    const timeChanged = mode === 'edit' && editing && editing.time !== time;
    const occCount: Record<string, number> = {};
    const serviceRequests: ServiceRequest[] = [];

    for (const s of selectedServices) {
      const occ = occCount[s.serviceName] ?? 0;
      occCount[s.serviceName] = occ + 1;
      // Find existing entry for this service/occurrence (preserves startTime from dragging)
      const reqsForSvc = existingReqs.filter((r) => r.service === s.serviceName);
      const existingReq = reqsForSvc[occ] ?? null;
      const preservedStartTime = timeChanged ? undefined : existingReq?.startTime;
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
        const base = timeChanged ? { ...existingReq, startTime: undefined } : existingReq;
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
    // If no specific manicurist was requested in a service, fall back to the column
    // the receptionist clicked on when opening the modal (draft?.manicuristId)
    // For edit mode: preserve existing manicuristId if no new client request was made.
    // For add mode: fall back to the column the receptionist clicked on (draft?.manicuristId).
    const appointmentManicuristId = firstRequestedId
      ?? (mode === 'edit' && editing ? editing.manicuristId : null)
      ?? draft?.manicuristId
      ?? null;
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
          sameTime,
          partyId,
        },
      });
    } else {
      // New booking — defer dispatch until the receptionist PIN is verified.
      setPendingBooking({ name, services, serviceRequests, appointmentManicuristId, partyId });
      setShowBookGate(true);
      return;
    }

    // Edit path: dispatch already ran above. Sync the customer profile and
    // close the modal. New bookings flow through the PIN gate instead.
    void upsertCustomerFromIntake({
      firstName: clientFirstName,
      lastName: clientLastName,
      phone: clientPhone,
    });

    handleClose();
  }

  /**
   * Final commit for a NEW booking once the receptionist has authenticated
   * via the PIN gate. `receptionistId` becomes the appointment's
   * bookedByReceptionistId so reports can attribute the booking later.
   */
  function commitNewBooking(receptionistId: string) {
    if (!pendingBooking) return;
    const { name, services, serviceRequests, appointmentManicuristId, partyId } = pendingBooking;
    const appt: Appointment = {
      id: crypto.randomUUID(),
      clientName: name,
      clientPhone: clientPhone.trim(),
      service: services[0],
      services: services as Appointment['services'],
      serviceRequests: serviceRequests as Appointment['serviceRequests'],
      manicuristId: appointmentManicuristId,
      date,
      time,
      notes: notes.trim(),
      status: 'scheduled',
      createdAt: Date.now(),
      sameTime,
      partyId,
      bookedByReceptionistId: receptionistId,
    };
    dispatch({ type: 'ADD_APPOINTMENT', appointment: appt });
    void upsertCustomerFromIntake({
      firstName: clientFirstName,
      lastName: clientLastName,
      phone: clientPhone,
    });
    setShowBookGate(false);
    setPendingBooking(null);
    const receptionist = state.manicurists.find((m) => m.id === receptionistId);
    const staff = appointmentManicuristId
      ? state.manicurists.find((m) => m.id === appointmentManicuristId)?.name ?? ''
      : '';
    setRecap({
      clientName: name,
      services: services as string[],
      date,
      time,
      staffName: staff,
      receptionistName: receptionist?.name ?? '',
    });
  }

  function handleClose() {
    dispatch({ type: 'SET_MODAL', modal: null });
    dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: null });
    dispatch({ type: 'SET_APPOINTMENT_DRAFT', draft: null });
  }

  return (
    <Modal
      title={mode === 'edit' ? 'EDIT APPOINTMENT' : 'NEW APPOINTMENT'}
      onClose={handleClose}
      width="max-w-2xl"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'edit' && editing?.bookedByReceptionistId && (
          <p className="font-mono text-[10px] tracking-wider text-gray-400 uppercase">
            Booked by{' '}
            <span className="font-bold text-gray-600">
              {state.manicurists.find((m) => m.id === editing.bookedByReceptionistId)?.name ?? 'unknown'}
            </span>
          </p>
        )}

        {matchedCustomer ? (
          <MatchedCustomerBanner
            customer={matchedCustomer}
            openAppointmentsCount={
              matchAppointments(matchedCustomer, state.appointments)
                .filter((a) => a.status === 'scheduled' || a.status === 'checked-in')
                .length
            }
            onClear={() => { setMatchedCustomer(null); }}
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
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
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
        </div>

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
        </div>

        <button
          type="submit"
          disabled={selectedServices.length === 0}
          className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {mode === 'edit' ? 'SAVE CHANGES' : 'BOOK APPOINTMENT'}
        </button>
      </form>
    {recap && (
      <BookingRecapModal
        info={recap}
        onClose={() => { setRecap(null); handleClose(); }}
      />
    )}
    {showBookGate && (
      <ReceptionistPinGate
        open={showBookGate}
        title="BOOK APPOINTMENT"
        subtitle={`Confirming booking for ${(clientFirstName + ' ' + clientLastName).trim() || 'Walk-in'}.`}
        confirmLabel="BOOK"
        tone="primary"
        receptionists={state.manicurists.filter((m) => m.isReceptionist)}
        onCancel={() => { setShowBookGate(false); setPendingBooking(null); }}
        onConfirm={(receptionistId) => commitNewBooking(receptionistId)}
      />
    )}
    </Modal>
  );
}


// ── Matched-customer banner ──────────────────────────────────────────────────

function MatchedCustomerBanner({
  customer, openAppointmentsCount, onClear,
}: {
  customer: Customer;
  openAppointmentsCount: number;
  onClear: () => void;
}) {
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-3 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-mono text-[10px] tracking-wider font-bold text-emerald-700 uppercase">
          Matched profile
        </p>
        <p className="font-mono text-sm font-semibold text-gray-900 truncate">
          {displayCustomerName(customer)}
        </p>
        <p className="font-mono text-xs text-gray-500">
          {customer.phone || 'no phone'} · {openAppointmentsCount} open appointment{openAppointmentsCount === 1 ? '' : 's'}
        </p>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="font-mono text-[10px] tracking-wider font-bold text-gray-500 hover:text-gray-800 uppercase"
      >
        Clear
      </button>
    </div>
  );
}

// ── Booking recap ────────────────────────────────────────────────────────────

function BookingRecapModal({
  info, onClose,
}: {
  info: {
    clientName: string;
    services: string[];
    date: string;
    time: string;
    staffName: string;
    receptionistName: string;
  };
  onClose: () => void;
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
          <RecapLine label="Services" value={info.services.join(', ') || '\u2014'} />
          <RecapLine label="When" value={`${formatDate(info.date)} · ${formatTime(info.time)}`} />
          <RecapLine label="Staff" value={info.staffName || '\u2014'} />
          <RecapLine label="Booked by" value={info.receptionistName || '\u2014'} />
        </div>
        <div className="flex justify-end">
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
