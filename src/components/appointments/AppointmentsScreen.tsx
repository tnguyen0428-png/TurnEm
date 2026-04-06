import { useState } from 'react';
import { Plus, CalendarCheck, Phone, Pencil, Trash2, UserCheck, XCircle, AlertTriangle } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import Badge from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import type { Appointment, QueueEntry, ServiceType } from '../../types';

const STATUS_CONFIG: Record<Appointment['status'], { label: string; variant: 'green' | 'blue' | 'amber' | 'pink' | 'red' | 'gray' }> = {
  'scheduled': { label: 'SCHEDULED', variant: 'blue' },
  'checked-in': { label: 'CHECKED IN', variant: 'green' },
  'completed': { label: 'COMPLETED', variant: 'gray' },
  'cancelled': { label: 'CANCELLED', variant: 'red' },
  'no-show': { label: 'NO SHOW', variant: 'amber' },
};

function formatDateDisplay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTimeDisplay(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
}

export default function AppointmentsScreen() {
  const { state, dispatch } = useApp();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const filtered = state.appointments
    .filter((a) => {
      if (filterDate && a.date !== filterDate) return false;
      if (filterStatus !== 'all' && a.status !== filterStatus) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    });

  function getManicuristName(id: string | null) {
    if (!id) return 'Any available';
    const m = state.manicurists.find((m) => m.id === id);
    return m ? m.name : 'Unknown';
  }

  function getManicuristColor(id: string | null) {
    if (!id) return '#9ca3af';
    const m = state.manicurists.find((m) => m.id === id);
    return m ? m.color : '#9ca3af';
  }

  function handleStatusChange(apptId: string, newStatus: Appointment['status']) {
    dispatch({ type: 'UPDATE_APPOINTMENT', id: apptId, updates: { status: newStatus } });
  }

  function handleCheckIn(appt: Appointment) {
    dispatch({ type: 'UPDATE_APPOINTMENT', id: appt.id, updates: { status: 'checked-in' } });
    const service = appt.service as ServiceType;
    const isRequested = !!appt.manicuristId;
    const baseTurn = SERVICE_TURN_VALUES[service] ?? 1;
    const turnValue = isRequested && baseTurn > 0 ? 0.5 : baseTurn;
    const serviceRequests = [{ service, manicuristIds: appt.manicuristId ? [appt.manicuristId] : [] }];
    const newClient: QueueEntry = {
      id: crypto.randomUUID(),
      clientName: appt.clientName || 'Walk-in',
      services: [service],
      turnValue,
      serviceRequests,
      requestedManicuristId: appt.manicuristId,
      isRequested,
      isAppointment: true,
      assignedManicuristId: null,
      status: 'waiting',
      arrivedAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };
    if (isRequested && appt.manicuristId) {
      const manicurist = state.manicurists.find((m) => m.id === appt.manicuristId);
      if (manicurist && manicurist.status === 'available') {
        dispatch({ type: 'REQUEST_ASSIGN', client: newClient, manicuristId: appt.manicuristId });
        return;
      }
    }
    dispatch({ type: 'ADD_CLIENT', client: newClient });
  }

  return (
    <div className="max-w-5xl mx-auto p-4 sm:p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-6">
        <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">APPOINTMENTS</h2>
        <button
          onClick={() => dispatch({ type: 'SET_MODAL', modal: 'addAppointment' })}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-pink-500 text-white font-mono text-xs font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all"
        >
          <Plus size={14} />
          NEW APPOINTMENT
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <input
          type="date"
          value={filterDate}
          onChange={(e) => setFilterDate(e.target.value)}
          className="px-3 py-2 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white"
        />
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 rounded-xl border border-gray-200 font-mono text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white"
        >
          <option value="all">All statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="checked-in">Checked In</option>
          <option value="completed">Completed</option>
          <option value="cancelled">Cancelled</option>
          <option value="no-show">No Show</option>
        </select>
        {filterDate && (
          <button
            onClick={() => setFilterDate('')}
            className="px-3 py-2 rounded-xl border border-gray-200 font-mono text-[10px] text-gray-500 hover:bg-gray-50 transition-colors"
          >
            Show all dates
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck size={48} />}
          title="No appointments found"
          description={filterDate ? `No appointments for ${formatDateDisplay(filterDate)}` : 'Create your first appointment'}
        />
      ) : (
        <div className="space-y-3">
          {filtered.map((appt) => {
            const statusConf = STATUS_CONFIG[appt.status];
            return (
              <div
                key={appt.id}
                className={`bg-white rounded-xl border transition-all duration-200 hover:shadow-md ${
                  appt.status === 'cancelled' || appt.status === 'no-show'
                    ? 'border-gray-100 opacity-60'
                    : appt.status === 'checked-in'
                    ? 'border-emerald-200'
                    : 'border-gray-100'
                }`}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        <h3 className="font-mono text-sm font-semibold text-gray-900">
                          {appt.clientName || 'Walk-in'}
                        </h3>
                        <Badge label={statusConf.label} variant={statusConf.variant} />
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                        <span className="font-mono text-xs text-gray-600">
                          {formatDateDisplay(appt.date)} at {formatTimeDisplay(appt.time)}
                        </span>
                        <span className="font-mono text-xs text-gray-500">{appt.service}</span>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="w-2 h-2 rounded-full"
                            style={{ backgroundColor: getManicuristColor(appt.manicuristId) }}
                          />
                          <span className="font-mono text-xs text-gray-500">
                            {getManicuristName(appt.manicuristId)}
                          </span>
                        </span>
                        {appt.clientPhone && (
                          <span className="flex items-center gap-1 font-mono text-[10px] text-gray-400">
                            <Phone size={10} />
                            {appt.clientPhone}
                          </span>
                        )}
                      </div>
                      {appt.notes && (
                        <p className="font-mono text-[11px] text-gray-400 mt-1.5 truncate">{appt.notes}</p>
                      )}
                    </div>

                    <div className="flex items-center gap-1 flex-shrink-0">
                      {appt.status === 'scheduled' && (
                        <>
                          <button
                            onClick={() => handleCheckIn(appt)}
                            className="p-1.5 rounded-lg bg-emerald-50 text-emerald-500 hover:bg-emerald-100 transition-colors"
                            title="Check In to Queue"
                          >
                            <UserCheck size={14} />
                          </button>
                          <button
                            onClick={() => handleStatusChange(appt.id, 'no-show')}
                            className="p-1.5 rounded-lg bg-amber-50 text-amber-500 hover:bg-amber-100 transition-colors"
                            title="No Show"
                          >
                            <AlertTriangle size={14} />
                          </button>
                          <button
                            onClick={() => handleStatusChange(appt.id, 'cancelled')}
                            className="p-1.5 rounded-lg bg-red-50 text-red-400 hover:bg-red-100 transition-colors"
                            title="Cancel"
                          >
                            <XCircle size={14} />
                          </button>
                        </>
                      )}
                      {appt.status === 'checked-in' && (
                        <button
                          onClick={() => handleStatusChange(appt.id, 'completed')}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500 text-white font-mono text-[10px] font-semibold hover:bg-emerald-600 transition-colors"
                        >
                          COMPLETE
                        </button>
                      )}
                      <button
                        onClick={() => {
                          dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: appt.id });
                          dispatch({ type: 'SET_MODAL', modal: 'editAppointment' });
                        }}
                        className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteId(appt.id)}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={14} />
                      </button>
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
          <div>
            <p className="font-bebas text-2xl text-gray-900">
              {filtered.filter((a) => a.status === 'scheduled').length}
            </p>
            <p className="font-mono text-[10px] text-gray-400 tracking-wider">SCHEDULED</p>
          </div>
          <div>
            <p className="font-bebas text-2xl text-emerald-600">
              {filtered.filter((a) => a.status === 'checked-in').length}
            </p>
            <p className="font-mono text-[10px] text-gray-400 tracking-wider">CHECKED IN</p>
          </div>
          <div>
            <p className="font-bebas text-2xl text-gray-500">
              {filtered.filter((a) => a.status === 'completed').length}
            </p>
            <p className="font-mono text-[10px] text-gray-400 tracking-wider">COMPLETED</p>
          </div>
          <div>
            <p className="font-bebas text-2xl text-red-500">
              {filtered.filter((a) => a.status === 'cancelled' || a.status === 'no-show').length}
            </p>
            <p className="font-mono text-[10px] text-gray-400 tracking-wider">CANCELLED / NO SHOW</p>
          </div>
        </div>
      </div>

      {deleteId && (
        <ConfirmDialog
          message="Delete this appointment? This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            dispatch({ type: 'DELETE_APPOINTMENT', id: deleteId });
            setDeleteId(null);
          }}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
