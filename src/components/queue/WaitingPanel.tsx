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
