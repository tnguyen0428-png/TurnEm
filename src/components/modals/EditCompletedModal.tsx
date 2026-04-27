import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import type { CompletedEntry } from '../../types';

interface Props {
  entry: CompletedEntry;
  onClose: () => void;
}

export default function EditCompletedModal({ entry, onClose }: Props) {
  const { state, dispatch } = useApp();
  const [manicuristId, setManicuristId] = useState(entry.manicuristId);
  const [turnValue, setTurnValue] = useState(String(entry.turnValue));
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Show all manicurists (clocked-in or not) so a user can fix a misattribution
  // even if the original tech has since clocked out.
  const manicuristOptions = [...state.manicurists].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  function handleSave() {
    const parsed = parseFloat(turnValue);
    const safeTurn = Number.isFinite(parsed) && parsed >= 0 ? parsed : entry.turnValue;
    const m = state.manicurists.find((x) => x.id === manicuristId);
    dispatch({
      type: 'UPDATE_COMPLETED',
      id: entry.id,
      updates: {
        manicuristId,
        manicuristName: m?.name ?? entry.manicuristName,
        manicuristColor: m?.color ?? entry.manicuristColor,
        turnValue: safeTurn,
      },
    });
    onClose();
  }

  function handleDelete() {
    dispatch({ type: 'DELETE_COMPLETED', id: entry.id });
    onClose();
  }

  return (
    <Modal title="EDIT SERVICE" onClose={onClose} width="max-w-md">
      <div className="flex flex-col gap-4">
        <div>
          <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
            Client
          </label>
          <p className="font-mono text-sm font-bold text-gray-900 mt-1">{entry.clientName}</p>
        </div>

        <div>
          <label className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
            Services
          </label>
          <p className="font-mono text-xs text-gray-700 mt-1">{entry.services.join(', ')}</p>
        </div>

        <div>
          <label
            htmlFor="edit-completed-manicurist"
            className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase block mb-1"
          >
            Manicurist
          </label>
          <select
            id="edit-completed-manicurist"
            value={manicuristId}
            onChange={(e) => setManicuristId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-xs font-semibold text-gray-700 bg-white focus:outline-none focus:border-gray-400"
          >
            {manicuristOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="edit-completed-turns"
            className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase block mb-1"
          >
            Turn Value
          </label>
          <input
            id="edit-completed-turns"
            type="number"
            step="0.5"
            min="0"
            value={turnValue}
            onChange={(e) => setTurnValue(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-xs font-semibold text-gray-700 bg-white focus:outline-none focus:border-gray-400"
          />
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-gray-100">
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-red-500 font-semibold">DELETE?</span>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-lg bg-red-500 text-white font-mono text-[10px] font-bold hover:bg-red-600 transition-colors"
              >
                YES
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 font-mono text-[10px] font-bold hover:bg-gray-50 transition-colors"
              >
                NO
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border-2 border-red-200 text-red-500 font-mono text-[10px] font-bold hover:bg-red-50 transition-colors"
            >
              <Trash2 size={12} />
              DELETE
            </button>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50 transition-colors"
            >
              CANCEL
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 rounded-lg bg-gray-900 text-white font-mono text-xs font-bold hover:bg-gray-800 transition-colors"
            >
              SAVE
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
