import { useState } from 'react';
import {
  Plus, CalendarCheck, Phone, Pencil, Trash2, UserCheck,
  XCircle, AlertTriangle, ChevronLeft, ChevronRight, LayoutGrid, List, Maximize2, Minimize2,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import Badge from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import AppointmentBookView from './AppointmentBookView';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import { getTodayLA, formatTimeOfDay } from '../../utils/time';
import type { Appointment, QueueEntry, ServiceType } from '../../types';

const STATUS_CONFIG: Record<Appointment['status'], { label: string; variant: 'green' | 'blue' | 'amber' | 'pink' | 'red' | 'gray' }> = {
  'scheduled':  { label: 'SCHEDULED',  variant: 'blue' },
  'checked-in': { label: 'CHECKED IN', variant: 'green' },
  'completed':  { label: 'COMPLETED',  variant: 'gray' },
  'cancelled':  { label: 'CANCELLED',  variant: 'red' },
  'no-show':    { label: 'NO SHOW',    variant: 'amber' },
};

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDateFull(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function shiftDate(dateStr: string, delta: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  return d.toISOString().split('T')[0];
}

export default function AppointmentsScreen() {
  const { state, dispatch } = useApp();
  const today = getTodayLA();

  const [bookMode, setBookMode] = useState<'book' | 'list'>('book');
  const [selectedDate, setSelectedDate] = useState(today);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [expanded, setExpanded] = useState(true);

  const filtered = state.appointments
    .filter((a) => {
      if (a.date !== selectedDate) return false;
      if (filterStatus !== 'all' && a.status !== filterStatus) return false;
      return true;
    })
    .sort((a, b) => a.time.localeCompare(b.time));

  function getManicuristName(id: string | null) {
    if (!id) return 'Any available';
    return state.manicurists.find((m) => m.id === id)?.name ?? 'Unknown';
  }

  function getManicuristColor(id: string | null) {
    if (!id) return '#9ca3af';
    return state.manicurists.find((m) => m.id === id)?.color ?? '#9ca3af';
  }

  function handleStatusChange(apptId: string, newStatus: Appointment['status']) {
    dispatch({ type: 'UPDATE_APPOINTMENT', id: apptId, updates: { status: newStatus } });
  }

  function handleCheckIn(appt: Appointment) {
    dispatch({ type: 'DELETE_APPOINTMENT', id: appt.id });
    const services = appt.services?.length ? appt.services : [appt.service as ServiceType];
    // CRITICAL: only ServiceRequests with clientRequest === true represent an actual
    // request from the customer. Anything else is just a salon-placed parking slot in
    // the calendar column (e.g. dragged into Z-Test 2's column for visual scheduling)
    // and must NOT be carried into the queue as a request — assignment for those is
    // determined when the customer arrives. We strip manicuristIds from non-request
    // entries so downstream queue/turn logic doesn't show them with a REQ badge or
    // "WAITING FOR" chip. Mirrors addApptToQueue in AppointmentBookView.
    const rawRequests = appt.serviceRequests?.length
      ? appt.serviceRequests
      : []; // top-level appt.manicuristId is a column placement, not a client request
    const serviceRequests = rawRequests.map((r) =>
      r.clientRequest === true ? r : { ...r, manicuristIds: [] }
    );
    const isRequested = serviceRequests.some((r) => r.clientRequest === true && r.manicuristIds.length > 0);
    const firstRequestedId = serviceRequests.find((r) => r.clientRequest === true)?.manicuristIds?.[0] ?? null;
    const turnValue = services.reduce((sum, svc) => {
      const s = state.salonServices.find((ss) => ss.name === svc);
      const base = s?.turnValue ?? SERVICE_TURN_VALUES[svc] ?? 1;
      const hasReq = serviceRequests.some((r) => r.service === svc && r.clientRequest === true && r.manicuristIds.length > 0);
      return sum + (hasReq && base > 0 ? (s?.category === 'Combo' ? 1 : 0.5) : base);
    }, 0);
    const newClient: QueueEntry = {
      id: crypto.randomUUID(),
      clientName: appt.clientName || 'Walk-in',
      services, turnValue, serviceRequests,
      requestedManicuristId: firstRequestedId,
      isRequested, isAppointment: true,
      assignedManicuristId: null, status: 'waiting',
      arrivedAt: Date.now(), startedAt: null, completedAt: null, extraTimeMs: 0,
      // Snapshot the original appointment so the queue card's Revert button can
      // restore the appointment exactly as it was (including non-request salon
      // assignments stripped above).
      originalAppointment: appt,
    };
    dispatch({ type: 'ADD_CLIENT', client: newClient });
  }

  function openNewAppointment() {
    dispatch({ type: 'SET_APPOINTMENT_DRAFT', draft: { date: selectedDate } });
    dispatch({ type: 'SET_MODAL', modal: 'addAppointment' });
  }

  const isToday = selectedDate === today;
  const dayTotal = state.appointments.filter((a) => a.date === selectedDate).length;
  const dayScheduled = state.appointments.filter((a) => a.date === selectedDate && a.status === 'scheduled').length;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Compact top bar (expanded book mode) ─────────────────────────────── */}
      {expanded && bookMode === 'book' && (
        <div className="flex-shrink-0 border-b border-gray-100 bg-white px-4 py-2 flex items-center gap-3">
          <div className="flex items-center gap-1 bg-gray-50 rounded-xl p-1">
            <button onClick={() => setSelectedDate(shiftDate(selectedDate, -1))} className="p-1.5 rounded-lg hover:bg-white text-gray-500 transition-all"><ChevronLeft size={14} /></button>
            <button onClick={() => setSelectedDate(today)} className={`px-2.5 py-1 rounded-lg font-mono text-[10px] font-semibold transition-all ${isToday ? 'bg-pink-500 text-white' : 'text-gray-500 hover:bg-white'}`}>TODAY</button>
            <button onClick={() => setSelectedDate(shiftDate(selectedDate, 1))} className="p-1.5 rounded-lg hover:bg-white text-gray-500 transition-all"><ChevronRight size={14} /></button>
          </div>
          <span className="font-bebas text-base tracking-[2px] text-gray-700 flex-1 truncate">{formatDateFull(selectedDate)}</span>
          {dayTotal > 0 && <span className="font-mono text-[10px] text-gray-400 flex-shrink-0">{dayScheduled} scheduled &middot; {dayTotal} total</span>}
          <button onClick={openNewAppointment} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-pink-500 text-white font-mono text-[10px] font-semibold hover:bg-pink-600 transition-all flex-shrink-0"><Plus size={12} />NEW</button>
          <button onClick={() => setExpanded((e) => !e)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gray-100 hover:bg-gray-200 font-mono text-[10px] text-gray-600 font-semibold transition-all flex-shrink-0">
            <Minimize2 size={12} />COMPACT
          </button>
        </div>
      )}

      {/* ── Full toolbar — hidden when book is expanded ──────────────────────── */}
      {!(expanded && bookMode === 'book') && (
        <div className="flex-shrink-0 bg-white border-b border-gray-100 px-4 sm:px-6 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 bg-gray-50 rounded-xl p-1">
              <button onClick={() => setSelectedDate(shiftDate(selectedDate, -1))} className="p-1.5 rounded-lg hover:bg-white hover:shadow-sm text-gray-500 transition-all"><ChevronLeft size={16} /></button>
              <button onClick={() => setSelectedDate(today)} className={`px-3 py-1 rounded-lg font-mono text-xs font-semibold transition-all ${isToday ? 'bg-pink-500 text-white shadow-sm' : 'text-gray-500 hover:bg-white hover:shadow-sm'}`}>TODAY</button>
              <button onClick={() => setSelectedDate(shiftDate(selectedDate, 1))} className="p-1.5 rounded-lg hover:bg-white hover:shadow-sm text-gray-500 transition-all"><ChevronRight size={16} /></button>
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="font-bebas text-xl tracking-[2px] text-gray-900 truncate">{formatDateFull(selectedDate)}</h2>
              {dayTotal > 0 && <p className="font-mono text-[10px] text-gray-400">{dayScheduled} scheduled &middot; {dayTotal} total</p>}
            </div>
            <input type="date" value={selectedDate} onChange={(e) => e.target.value && setSelectedDate(e.target.value)} className="px-2 py-1.5 rounded-xl border border-gray-200 font-mono text-xs text-gray-500 focus:outline-none focus:ring-2 focus:ring-pink-200 bg-white hidden sm:block" />
            <div className="flex items-center bg-gray-100 rounded-xl p-1 gap-0.5">
              <button onClick={() => setBookMode('book')} title="Book view" className={`p-1.5 rounded-lg transition-all ${bookMode === 'book' ? 'bg-white text-pink-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}><LayoutGrid size={15} /></button>
              <button onClick={() => setBookMode('list')} title="List view" className={`p-1.5 rounded-lg transition-all ${bookMode === 'list' ? 'bg-white text-pink-600 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}><List size={15} /></button>
            </div>
            <button onClick={openNewAppointment} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-pink-500 text-white font-mono text-xs font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all shadow-sm"><Plus size={14} />NEW</button>
          </div>
        </div>
      )}

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {bookMode === 'book' && <AppointmentBookView selectedDate={selectedDate} />}

        {bookMode === 'list' && (
          <div className="max-w-5xl mx-auto p-4 sm:p-6 overflow-y-auto h-full">
            <div className="flex flex-wrap gap-2 mb-5">
              {(['all', 'scheduled', 'checked-in', 'completed', 'cancelled', 'no-show'] as const).map((s) => (
                <button key={s} onClick={() => setFilterStatus(s)} className={`px-3 py-1.5 rounded-xl font-mono text-[10px] font-semibold transition-all ${filterStatus === s ? 'bg-pink-500 text-white shadow-sm' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {s === 'all' ? 'ALL' : s.toUpperCase().replace('-', ' ')}
                </button>
              ))}
            </div>
            {filtered.length === 0 ? (
              <EmptyState icon={<CalendarCheck size={48} />} title="No appointments" description={`Nothing on ${formatDateDisplay(selectedDate)}`} />
            ) : (
              <div className="space-y-3">
                {filtered.map((appt) => {
                  const statusConf = STATUS_CONFIG[appt.status];
                  return (
                    <div key={appt.id} className={`bg-white rounded-xl border transition-all duration-200 hover:shadow-md ${appt.status === 'cancelled' || appt.status === 'no-show' ? 'border-gray-100 opacity-60' : appt.status === 'checked-in' ? 'border-emerald-200' : 'border-gray-100'}`}>
                      <div className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-2">
                              <h3 className="font-mono text-sm font-semibold text-gray-900">{appt.clientName || 'Walk-in'}</h3>
                              <Badge label={statusConf.label} variant={statusConf.variant} />
                            </div>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                              <span className="font-mono text-xs text-gray-600">{formatTimeOfDay(appt.time)}</span>
                              <span className="font-mono text-xs text-gray-500">{(appt.services?.length ? appt.services : [appt.service]).join(' + ')}</span>
                              {(appt.serviceRequests?.length ? appt.serviceRequests.filter((r) => r.manicuristIds.length > 0) : appt.manicuristId ? [{ manicuristIds: [appt.manicuristId] }] : []).map((r, i) => (
                                <span key={i} className="flex items-center gap-1.5">
                                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getManicuristColor(r.manicuristIds[0]) }} />
                                  <span className="font-mono text-xs text-gray-500">{getManicuristName(r.manicuristIds[0])}</span>
                                </span>
                              ))}
                              {appt.clientPhone && <span className="flex items-center gap-1 font-mono text-[10px] text-gray-400"><Phone size={10} />{appt.clientPhone}</span>}
                            </div>
                            {appt.notes && <p className="font-mono text-[11px] text-gray-400 mt-1.5 truncate">{appt.notes}</p>}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {appt.status === 'scheduled' && (
                              <>
                                <button onClick={() => handleCheckIn(appt)} className="p-1.5 rounded-lg bg-emerald-50 text-emerald-500 hover:bg-emerald-100 transition-colors" title="Check In"><UserCheck size={14} /></button>
                                <button onClick={() => handleStatusChange(appt.id, 'no-show')} className="p-1.5 rounded-lg bg-amber-50 text-amber-500 hover:bg-amber-100 transition-colors" title="No Show"><AlertTriangle size={14} /></button>
                                <button onClick={() => handleStatusChange(appt.id, 'cancelled')} className="p-1.5 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 transition-colors" title="Cancel"><XCircle size={14} /></button>
                              </>
                            )}
                            {appt.status === 'checked-in' && <button onClick={() => handleStatusChange(appt.id, 'completed')} className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white font-mono text-[10px] font-semibold hover:bg-emerald-600 transition-colors">COMPLETE</button>}
                            <button onClick={() => { dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: appt.id }); dispatch({ type: 'SET_MODAL', modal: 'editAppointment' }); }} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"><Pencil size={14} /></button>
                            <button onClick={() => setDeleteId(appt.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"><Trash2 size={14} /></button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="mt-6 bg-white rounded-xl border border-gray-100 p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
                {[
                  { label: 'SCHEDULED', count: filtered.filter((a) => a.status === 'scheduled').length, color: 'text-blue-600' },
                  { label: 'CHECKED IN', count: filtered.filter((a) => a.status === 'checked-in').length, color: 'text-emerald-600' },
                  { label: 'COMPLETED', count: filtered.filter((a) => a.status === 'completed').length, color: 'text-gray-500' },
                  { label: 'MISSED', count: filtered.filter((a) => a.status === 'cancelled' || a.status === 'no-show').length, color: 'text-red-500' },
                ].map(({ label, count, color }) => (
                  <div key={label}><p className={`font-bebas text-2xl ${color}`}>{count}</p><p className="font-mono text-[10px] text-gray-400 tracking-wider">{label}</p></div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom bar (compact book view only — FULL PAGE toggle + hint) ───── */}
      {bookMode === 'book' && !expanded && (
        <div className="flex-shrink-0 border-t border-gray-100 bg-white px-4 py-2 flex items-center gap-3">
          <span className="font-mono text-[10px] text-gray-400 flex-1">Drag column headers to reorder staff</span>
          <button onClick={() => setExpanded((e) => !e)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gray-100 hover:bg-gray-200 font-mono text-[10px] text-gray-600 font-semibold transition-all flex-shrink-0">
            <Maximize2 size={12} />FULL PAGE
          </button>
        </div>
      )}

      {deleteId && (
        <ConfirmDialog
          message="Delete this appointment? This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => { dispatch({ type: 'DELETE_APPOINTMENT', id: deleteId }); setDeleteId(null); }}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
