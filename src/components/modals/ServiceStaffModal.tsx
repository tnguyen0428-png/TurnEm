import { useMemo } from 'react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import { staffSkillUpdates } from '../../utils/serviceCategories';

interface ServiceStaffModalProps {
  serviceId: string;
  onClose: () => void;
}

// Quick "who does this service" picker opened from a service row. Every click
// saves immediately, computed from the latest manicurist rows so it never
// clobbers someone's other skills.
export default function ServiceStaffModal({ serviceId, onClose }: ServiceStaffModalProps) {
  const { state, dispatch } = useApp();
  const service = state.salonServices.find((s) => s.id === serviceId);

  // Receptionist-only accounts (no skills) are left out, matching StaffModal.
  const staff = useMemo(
    () => state.manicurists.filter((m) => !(m.isReceptionist && m.skills.length === 0)),
    [state.manicurists],
  );

  if (!service) return null;
  const name = service.name;
  const holders = new Set(staff.filter((m) => m.skills.includes(name)).map((m) => m.id));

  function apply(wanted: Set<string>) {
    const listed = new Set(staff.map((m) => m.id));
    for (const u of staffSkillUpdates(state.manicurists, listed, wanted, null, name)) {
      dispatch({ type: 'UPDATE_MANICURIST', id: u.id, updates: { skills: u.skills } });
    }
  }

  function toggle(id: string) {
    const next = new Set(holders);
    if (next.has(id)) next.delete(id); else next.add(id);
    apply(next);
  }

  return (
    <Modal title="STAFF" onClose={onClose}>
      <div className="flex items-center justify-between mb-3">
        <p className="font-mono text-sm font-semibold text-gray-900 truncate">
          {name}
          <span className="ml-2 font-normal text-gray-400">{holders.size} staff</span>
        </p>
        <div className="flex gap-3 flex-shrink-0">
          <button
            type="button"
            onClick={() => apply(new Set(staff.map((m) => m.id)))}
            className="font-mono text-[11px] font-semibold text-pink-500 hover:text-pink-600"
          >
            ALL
          </button>
          <button
            type="button"
            onClick={() => apply(new Set())}
            className="font-mono text-[11px] font-semibold text-gray-400 hover:text-gray-600"
          >
            NONE
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
        {staff.map((m) => {
          const on = holders.has(m.id);
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => toggle(m.id)}
              className={`flex items-center gap-2 px-2.5 py-2 rounded-lg border font-mono text-xs text-left transition-all ${
                on ? 'border-pink-300 bg-pink-50 text-gray-900' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'
              }`}
            >
              <span
                className={`w-3.5 h-3.5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
                  on ? 'bg-pink-500 border-pink-500' : 'border-gray-300'
                }`}
              >
                {on && (
                  <svg width="8" height="6" viewBox="0 0 8 6" fill="none">
                    <path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
              <span className="truncate">{m.name}</span>
            </button>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onClose}
        className="mt-5 w-full py-3 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all"
      >
        DONE
      </button>
    </Modal>
  );
}
