// ReceptionistClockModal — minimal clock-in/clock-out picker for receptionists.
//
// Triggered from the Register screen's clock pill. Lists receptionists with
// their current clocked-in/out state and a single button to flip it. Parent
// owns the store dispatch; this component only fires the callbacks and the
// local clockLog ledger for the reports tab.

import { X } from 'lucide-react';
import { appendEvent as appendClockEvent } from '../../lib/clockLog';
import type { Manicurist } from '../../types';

interface Props {
  receptionists: Manicurist[];
  onClose: () => void;
  onClockIn: (id: string) => void;
  onClockOut: (id: string) => void;
}

export default function ReceptionistClockModal({
  receptionists,
  onClose,
  onClockIn,
  onClockOut,
}: Props) {
  function handleToggle(r: Manicurist) {
    if (r.clockedIn) {
      onClockOut(r.id);
      appendClockEvent(r.id, r.name, 'out');
    } else {
      onClockIn(r.id);
      appendClockEvent(r.id, r.name, 'in');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col animate-modal-in">
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-bebas text-2xl tracking-widest text-gray-900">TIME CLOCK</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
          {receptionists.length === 0 ? (
            <div className="px-4 py-10 text-center font-mono text-xs text-gray-400">
              No receptionists configured.
            </div>
          ) : (
            receptionists.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: r.color }}
                  />
                  <span className="font-mono text-sm font-semibold text-gray-900 truncate">
                    {r.name}
                  </span>
                  <span
                    className={`font-mono text-[10px] tracking-wider font-bold px-2 py-0.5 rounded-full ${
                      r.clockedIn
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-gray-100 text-gray-500'
                    }`}
                  >
                    {r.clockedIn ? 'CLOCKED IN' : 'CLOCKED OUT'}
                  </span>
                </div>
                <button
                  onClick={() => handleToggle(r)}
                  className={`px-3 py-1.5 rounded-lg font-mono text-[11px] font-bold tracking-wider transition-colors ${
                    r.clockedIn
                      ? 'border border-red-200 text-red-600 hover:bg-red-50'
                      : 'bg-emerald-600 text-white hover:bg-emerald-700'
                  }`}
                >
                  {r.clockedIn ? 'CLOCK OUT' : 'CLOCK IN'}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
