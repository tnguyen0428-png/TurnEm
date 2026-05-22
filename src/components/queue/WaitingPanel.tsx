import { useState } from 'react';
import { Plus, Inbox } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { getPriorityQueue } from '../../utils/priority';
import QueueCard from './QueueCard';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import { fetchOpenShift } from '../../lib/shifts';

export default function WaitingPanel() {
  const { state, dispatch } = useApp();
  const [removeId, setRemoveId] = useState<string | null>(null);
  // Block manicurist assignment until a shift is open. The popup gates the
  // standard "assign client" entry point in the waiting panel so a receptionist
  // can't credit turns or kick off ticketing before the day's shift exists.
  const [noShiftReminder, setNoShiftReminder] = useState(false);

  const priorityQueue = getPriorityQueue(state.queue, state.manicurists, state.salonServices);

  async function handleAssign(clientId: string) {
    const shift = await fetchOpenShift();
    if (!shift) {
      setNoShiftReminder(true);
      return;
    }
    dispatch({ type: 'SET_SELECTED_CLIENT', clientId });
    dispatch({ type: 'SET_MODAL', modal: 'assignConfirm' });
  }

  function handleEdit(clientId: string) {
    dispatch({ type: 'SET_EDITING_CLIENT', clientId });
    dispatch({ type: 'SET_MODAL', modal: 'editClient' });
  }

  function handleRevertToAppt(clientId: string) {
    const entry = state.queue.find((c) => c.id === clientId);
    if (!entry) return;
    // Preferred path: restore from the snapshot captured when the appointment was
    // originally promoted via the "Q" key. The current flow KEEPS the appointment
    // alive in state.appointments (marked 'checked-in'), so if we can find that
    // existing row by id we just flip its status back to 'scheduled' — no new
    // row, no duplicate. For legacy queue entries where the appt was deleted
    // (older data), fall back to ADD_APPOINTMENT with a fresh id.
    if (entry.originalAppointment) {
      const existing = state.appointments.find((a) => a.id === entry.originalAppointment!.id);
      if (existing) {
        dispatch({
          type: 'UPDATE_APPOINTMENT',
          id: existing.id,
          updates: { status: 'scheduled' },
        });
      } else {
        dispatch({
          type: 'ADD_APPOINTMENT',
          appointment: {
            ...entry.originalAppointment,
            sameTime: entry.originalAppointment.sameTime ?? false,
            partyId: entry.originalAppointment.partyId ?? null,
            id: crypto.randomUUID(),
            status: 'scheduled',
            createdAt: Date.now(),
          },
        });
      }
      dispatch({ type: 'REMOVE_CLIENT', id: clientId });
      return;
    }
    // Fallback for queue entries that were never an appointment (legacy data
    // or direct walk-ins): drop them onto today at the current time.
    const today = new Date().toISOString().split('T')[0];
    const firstReqTime = entry.serviceRequests?.[0]?.startTime;
    const now = new Date();
    const time =
      firstReqTime ||
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    dispatch({
      type: 'ADD_APPOINTMENT',
      appointment: {
        id: crypto.randomUUID(),
        clientName: entry.clientName,
        clientPhone: '',
        service: entry.services[0] || '',
        services: entry.services,
        serviceRequests: entry.serviceRequests || [],
        manicuristId: entry.requestedManicuristId,
        date: today,
        time,
        notes: '',
        status: 'scheduled',
        createdAt: Date.now(),
        sameTime: false,
        partyId: null,
      },
    });
    dispatch({ type: 'REMOVE_CLIENT', id: clientId });
  }

  function confirmRemove() {
    if (removeId) {
      dispatch({ type: 'REMOVE_CLIENT', id: removeId });
      setRemoveId(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <h2 className="font-bebas text-lg tracking-[2px] text-gray-900">CLIENT WAITING</h2>
          {priorityQueue.length > 0 && (
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-pink-500 text-white text-[10px] font-mono font-bold">
              {priorityQueue.length}
            </span>
          )}
        </div>
        <button
          onClick={() => dispatch({ type: 'SET_MODAL', modal: 'addClient' })}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-pink-500 text-white font-mono text-xs font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all duration-150"
        >
          <Plus size={13} />
          ADD CLIENT
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {priorityQueue.length === 0 ? (
          <EmptyState
            icon={<Inbox size={48} />}
            title="No clients waiting"
            description="Add a new client to get started"
          />
        ) : (
          priorityQueue.map((client, idx) => (
            <QueueCard
              key={client.id}
              client={client}
              rank={idx + 1}
              isNext={idx === 0}
              isDeferred={client.isDeferred}
              manicurists={state.manicurists}
              salonServices={state.salonServices}
              onAssign={() => handleAssign(client.id)}
              onEdit={() => handleEdit(client.id)}
              onRemove={() => setRemoveId(client.id)}
              onRevertToAppt={() => handleRevertToAppt(client.id)}
            />
          ))
        )}
      </div>

      {removeId && (
        <ConfirmDialog
          message="Remove this client from the queue?"
          confirmLabel="Remove"
          danger
          onConfirm={confirmRemove}
          onCancel={() => setRemoveId(null)}
        />
      )}
      {noShiftReminder && (
        <ConfirmDialog
          message="No shift is open. Open today's shift on the Register tab before assigning a manicurist."
          confirmLabel="GOT IT"
          onConfirm={() => setNoShiftReminder(false)}
          onCancel={() => setNoShiftReminder(false)}
        />
      )}
    </div>
  );
}
