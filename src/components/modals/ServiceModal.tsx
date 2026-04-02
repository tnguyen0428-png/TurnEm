import { useState, useEffect } from 'react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import type { SalonService } from '../../types';
import { SERVICE_CATEGORIES } from '../../constants/services';

interface ServiceModalProps {
  mode: 'add' | 'edit';
  onClose: () => void;
}

export default function ServiceModal({ mode, onClose }: ServiceModalProps) {
  const { state, dispatch } = useApp();

  const editing = mode === 'edit'
    ? state.salonServices.find((s) => s.id === state.editingServiceId)
    : null;

  const [name, setName] = useState('');
  const [turnValue, setTurnValue] = useState(0);
  const [duration, setDuration] = useState(30);
  const [price, setPrice] = useState(0);
  const [category, setCategory] = useState(SERVICE_CATEGORIES[0]);

  useEffect(() => {
    if (editing) {
      setName(editing.name);
      setTurnValue(editing.turnValue);
      setDuration(editing.duration);
      setPrice(editing.price);
      setCategory(editing.category || SERVICE_CATEGORIES[0]);
    }
  }, [editing]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    if (mode === 'edit' && editing) {
      dispatch({
        type: 'UPDATE_SALON_SERVICE',
        id: editing.id,
        updates: {
          name: name.trim(),
          turnValue,
          duration,
          price,
          category,
        },
      });
    } else {
      const maxOrder = state.salonServices.reduce((max, s) => Math.max(max, s.sortOrder), -1);
      const svc: SalonService = {
        id: crypto.randomUUID(),
        name: name.trim(),
        turnValue,
        duration,
        price,
        isActive: true,
        category,
        sortOrder: maxOrder + 1,
        isFourthPositionSpecial: false,
      };
      dispatch({ type: 'ADD_SALON_SERVICE', service: svc });
    }

    onClose();
  }

  return (
    <Modal
      title={mode === 'edit' ? 'EDIT SERVICE' : 'ADD SERVICE'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            SERVICE NAME
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Gel Manicure"
            required
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
          />
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            CATEGORY
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white transition-all"
          >
            {SERVICE_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              TURN VALUE
            </label>
            <select
              value={turnValue}
              onChange={(e) => setTurnValue(Number(e.target.value))}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white transition-all"
            >
              <option value={0}>0</option>
              <option value={0.5}>0.5</option>
              <option value={1.0}>1.0</option>
              <option value={1.5}>1.5</option>
              <option value={2.0}>2.0</option>
              <option value={2.5}>2.5</option>
              <option value={3.0}>3.0</option>
            </select>
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              DURATION (MIN)
            </label>
            <input
              type="number"
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              min={5}
              step={5}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              PRICE ($)
            </label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(Number(e.target.value))}
              min={0}
              step={0.01}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={!name.trim()}
          className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
        >
          {mode === 'edit' ? 'SAVE CHANGES' : 'ADD SERVICE'}
        </button>
      </form>
    </Modal>
  );
}
