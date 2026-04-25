import { useState } from 'react';
import { Plus, Inbox } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { getPriorityQueue } from '../../utils/priority';
import QueueCard from './QueueCard';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';

export default function WaitingPanel() {
  const { state, dispatch } = useApp();
  const [removeId, setRemoveId] = useState<string | null>(null);

  const priorityQueue = getPriorityQueue(state.queue, state.manicurists, state.salonServices);

  function handleAssign(clientId: string) {
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
    // originally promoted via the "Q" key. This puts the appointment back into its
    // exact original date, time, column, and per-service placement — including the
    // manicuristIds we cleared from the queue's serviceRequests for parked entries.
    if (entry.originalAppointment) {
      dispatch({
        type: 'ADD_APPOINTMENT',
        appointment: {
          ...entry.originalAppointment,
          // Use a fresh id since the original was deleted on promotion.
          id: crypto.randomUUID(),
          status: 'scheduled',
          createdAt: Date.now(),
        },
      });
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
    </div>
  );
}
