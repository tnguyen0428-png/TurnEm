import { useState, useEffect } from 'react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import { ALL_SERVICES } from '../../constants/services';
import type { ServiceType, Appointment } from '../../types';

interface AppointmentModalProps {
  mode: 'add' | 'edit';
}

export default function AppointmentModal({ mode }: AppointmentModalProps) {
  const { state, dispatch } = useApp();

  const editing = mode === 'edit'
    ? state.appointments.find((a) => a.id === state.editingAppointmentId)
    : null;

  const today = new Date().toISOString().split('T')[0];
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [service, setService] = useState<ServiceType>('Manicure');
  const [manicuristId, setManicuristId] = useState<string>('');
  const [date, setDate] = useState(today);
  const [time, setTime] = useState('10:00');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (editing) {
      setClientName(editing.clientName);
      setClientPhone(editing.clientPhone);
      setService(editing.service);
      setManicuristId(editing.manicuristId || '');
      setDate(editing.date);
      setTime(editing.time);
      setNotes(editing.notes);
    }
  }, [editing]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = clientName.trim() || 'Walk-in';

    if (mode === 'edit' && editing) {
      dispatch({
        type: 'UPDATE_APPOINTMENT',
        id: editing.id,
        updates: {
          clientName: name,
          clientPhone: clientPhone.trim(),
          service,
          manicuristId: manicuristId || null,
          date,
          time,
          notes: notes.trim(),
        },
      });
    } else {
      const appt: Appointment = {
        id: crypto.randomUUID(),
        clientName: name,
        clientPhone: clientPhone.trim(),
        service,
        manicuristId: manicuristId || null,
        date,
        time,
        notes: notes.trim(),
        status: 'scheduled',
        createdAt: Date.now(),
      };
      dispatch({ type: 'ADD_APPOINTMENT', appointment: appt });
    }

    handleClose();
  }

  function handleClose() {
    dispatch({ type: 'SET_MODAL', modal: null });
    dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: null });
  }

  return (
    <Modal
      title={mode === 'edit' ? 'EDIT APPOINTMENT' : 'NEW APPOINTMENT'}
      onClose={handleClose}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              CLIENT NAME
            </label>
            <input
              type="text"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Walk-in"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              PHONE
            </label>
            <input
              type="tel"
              value={clientPhone}
              onChange={(e) => setClientPhone(e.target.value)}
              placeholder="(555) 123-4567"
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            SERVICE
          </label>
          <select
            value={service}
            onChange={(e) => setService(e.target.value as ServiceType)}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white transition-all"
          >
            {ALL_SERVICES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            MANICURIST (OPTIONAL)
          </label>
          <select
            value={manicuristId}
            onChange={(e) => setManicuristId(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 bg-white transition-all"
          >
            <option value="">Any available</option>
            {state.manicurists.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              DATE
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              min={today}
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              TIME
            </label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              required
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all"
            />
          </div>
        </div>

        <div>
          <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
            NOTES
          </label>
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
          className="w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all"
        >
          {mode === 'edit' ? 'SAVE CHANGES' : 'BOOK APPOINTMENT'}
        </button>
      </form>
    </Modal>
  );
}
