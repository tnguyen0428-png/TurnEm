import { useState } from 'react';
import {
  Users, Shield, Sparkles, Scale, CalendarDays, UsersRound,
  Clock3, ChevronRight, GripVertical, KeyRound,
} from 'lucide-react';
import { PinVerifyModal } from '../shared/AdminPinGate';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import StaffScreen from '../staff/StaffScreen';
import StaffScheduleScreen from '../staff/StaffScheduleScreen';
import ServicesScreen from '../services/ServicesScreen';
import CriteriaScreen from '../criteria/CriteriaScreen';
import CalendarScreen from '../calendar/CalendarScreen';
import { useApp } from '../../state/AppContext';
import type { Manicurist } from '../../types';

type BlueprintSection =
  | 'staff-management'
  | 'staff-schedule'
  | 'staff-group'
  | 'block-time'
  | 'security'
  | 'services'
  | 'criteria';

interface NavItem {
  id: BlueprintSection;
  label: string;
  icon: typeof Users;
  description: string;
}

const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'STAFF',
    items: [
      { id: 'staff-management', label: 'Staff Management', icon: Users,      description: 'Add, edit and manage staff members' },
      { id: 'staff-schedule',   label: 'Staff Schedule',   icon: Clock3,     description: 'Set working days per technician' },
      { id: 'staff-group',      label: 'Staff Group',      icon: UsersRound, description: 'Set roles and position order for staff' },
    ],
  },
  {
    heading: 'OPERATIONS',
    items: [
      { id: 'block-time', label: 'Block Time', icon: CalendarDays, description: 'Block days off and closures' },
      { id: 'security',   label: 'Security',   icon: Shield,       description: 'PIN codes and receptionist access' },
    ],
  },
  {
    heading: 'CONFIGURATION',
    items: [
      { id: 'services', label: 'Services', icon: Sparkles, description: 'Manage service types and pricing' },
      { id: 'criteria', label: 'Criteria', icon: Scale,    description: 'Turn assignment rules and priority' },
    ],
  },
];

// ─── Staff Group — sortable role table ────────────────────────────────────────
function SortableStaffRow({
  manicurist, isLast, onToggleBook, onToggleReceptionist,
}: {
  manicurist: Manicurist;
  isLast: boolean;
  onToggleBook: (val: boolean) => void;
  onToggleReceptionist: (val: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: manicurist.id });
  const inBook = manicurist.showInBook !== false;
  const isReceptionist = manicurist.isReceptionist === true;

  return (
    <div
      ref={setNodeRef}
      className={`grid items-center ${!isLast ? 'border-b border-gray-50' : ''}`}
      style={{
        gridTemplateColumns: '1fr 130px 150px',
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        background: isDragging ? '#fdf2f8' : 'white',
      }}
    >
      {/* Name + grip */}
      <div className="px-4 py-3.5 flex items-center gap-3">
        <div
          {...attributes}
          {...listeners}
          className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing flex-shrink-0 p-0.5 rounded hover:bg-gray-100 transition-colors"
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </div>
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: manicurist.color }} />
        <span className="font-mono text-[13px] font-semibold text-gray-800 truncate">{manicurist.name}</span>
      </div>

      {/* Manicurist toggle */}
      <div className="flex justify-center py-3.5">
        <button
          onClick={() => onToggleBook(!inBook)}
          className={`w-10 h-6 rounded-full transition-all relative flex-shrink-0 ${inBook ? 'bg-pink-500' : 'bg-gray-200'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${inBook ? 'left-4' : 'left-0.5'}`} />
        </button>
      </div>

      {/* Receptionist toggle */}
      <div className="flex justify-center py-3.5">
        <button
          onClick={() => onToggleReceptionist(!isReceptionist)}
          className={`w-10 h-6 rounded-full transition-all relative flex-shrink-0 ${isReceptionist ? 'bg-indigo-500' : 'bg-gray-200'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${isReceptionist ? 'left-4' : 'left-0.5'}`} />
        </button>
      </div>
    </div>
  );
}

function StaffGroupScreen() {
  const { state, dispatch } = useApp();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = state.manicurists.map((m) => m.id);
    const oldIdx = ids.indexOf(active.id as string);
    const newIdx = ids.indexOf(over.id as string);
    if (oldIdx === -1 || newIdx === -1) return;
    dispatch({ type: 'SET_MANICURIST_ORDER', ids: arrayMove(ids, oldIdx, newIdx) });
  }

  const bookCount = state.manicurists.filter((m) => m.showInBook !== false).length;
  const receptionistCount = state.manicurists.filter((m) => m.isReceptionist).length;

  return (
    <div className="p-6 overflow-y-auto h-full">
      <p className="font-mono text-xs text-gray-400 mb-2">
        Drag rows to reorder — position here matches column order in the appointment book.
      </p>
      <div className="flex gap-4 mb-5">
        <span className="font-mono text-[10px] text-pink-500 bg-pink-50 px-2.5 py-1 rounded-lg font-semibold">{bookCount} in appointment book</span>
        <span className="font-mono text-[10px] text-indigo-500 bg-indigo-50 px-2.5 py-1 rounded-lg font-semibold">{receptionistCount} receptionists</span>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {/* Header */}
        <div className="grid bg-gray-50 border-b border-gray-100" style={{ gridTemplateColumns: '1fr 130px 150px' }}>
          <div className="px-4 py-3 font-mono text-[10px] font-bold text-gray-400 tracking-wider">STAFF MEMBER</div>
          <div className="py-3 text-center font-mono text-[10px] font-bold text-pink-400 tracking-wider">MANICURIST</div>
          <div className="py-3 text-center font-mono text-[10px] font-bold text-indigo-400 tracking-wider">RECEPTIONIST</div>
        </div>

        {/* Hint row */}
        <div className="grid border-b border-gray-50 bg-gray-50/50" style={{ gridTemplateColumns: '1fr 130px 150px' }}>
          <div className="px-4 py-1.5 font-mono text-[9px] text-gray-300">Drag ⠿ to reorder</div>
          <div className="py-1.5 text-center font-mono text-[9px] text-gray-300">Shows in book</div>
          <div className="py-1.5 text-center font-mono text-[9px] text-gray-300">Can book appts</div>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={state.manicurists.map((m) => m.id)} strategy={verticalListSortingStrategy}>
            {state.manicurists.map((m, idx) => (
              <SortableStaffRow
                key={m.id}
                manicurist={m}
                isLast={idx === state.manicurists.length - 1}
                onToggleBook={(val) => dispatch({ type: 'UPDATE_MANICURIST', id: m.id, updates: { showInBook: val } })}
                onToggleReceptionist={(val) => dispatch({ type: 'UPDATE_MANICURIST', id: m.id, updates: { isReceptionist: val } })}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

// ─── Security ──────────────────────────────────────────────────────────────────
function SecurityScreen() {
  const { state, dispatch } = useApp();

  const receptionists = state.manicurists.filter((m) => m.isReceptionist);
  const allStaff = state.manicurists;

  function updatePin(id: string, pin: string) {
    if (pin.length > 4 || !/^\d*$/.test(pin)) return;
    dispatch({ type: 'UPDATE_MANICURIST', id, updates: { pinCode: pin } });
  }

  function PinRow({ m, borderBottom, accentColor = 'pink' }: { m: typeof allStaff[0]; borderBottom?: boolean; accentColor?: 'pink' | 'indigo' }) {
    return (
      <div className={`flex items-center gap-4 px-5 py-4 ${borderBottom ? 'border-b border-gray-50' : ''}`}>
        <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
        <span className="font-mono text-sm font-semibold text-gray-800 flex-1">{m.name}</span>
        {m.isReceptionist && <span className="font-mono text-[9px] text-indigo-400 bg-indigo-50 px-2 py-0.5 rounded-lg font-semibold">RECEPT.</span>}
        <input
          type="text"
          value={m.pinCode || ''}
          onChange={(e) => updatePin(m.id, e.target.value)}
          placeholder="0000"
          maxLength={4}
          className={`w-20 px-3 py-2 rounded-xl border border-gray-200 font-mono text-sm text-center text-gray-900 focus:outline-none focus:ring-2 ${accentColor === 'indigo' ? 'focus:ring-indigo-200' : 'focus:ring-pink-200'} tracking-widest`}
        />
      </div>
    );
  }

  return (
    <div className="p-6 overflow-y-auto h-full space-y-6">

      {/* Receptionists */}
      <div>
        <h3 className="font-bebas text-lg tracking-[2px] text-gray-800 mb-1">RECEPTIONIST ACCESS</h3>
        <p className="font-mono text-[11px] text-gray-400 mb-3">Staff marked as Receptionist in Staff Group can log in and book appointments.</p>
        {receptionists.length === 0 ? (
          <div className="bg-indigo-50 rounded-xl px-4 py-3 font-mono text-xs text-indigo-400">
            No receptionists assigned yet — go to <strong>Staff Group</strong> and toggle the Receptionist column.
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-indigo-100 overflow-hidden">
            {receptionists.map((m, idx) => (
              <div key={m.id} className={`flex items-center gap-4 px-5 py-4 ${idx < receptionists.length - 1 ? 'border-b border-gray-50' : ''}`}>
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: m.color }} />
                <span className="font-mono text-sm font-semibold text-gray-800 flex-1">{m.name}</span>
                <span className="font-mono text-[10px] text-indigo-500 bg-indigo-50 px-2 py-1 rounded-lg font-semibold">RECEPTIONIST</span>
                <input
                  type="text"
                  value={m.pinCode || ''}
                  onChange={(e) => updatePin(m.id, e.target.value)}
                  placeholder="0000"
                  maxLength={4}
                  className="w-20 px-3 py-2 rounded-xl border border-gray-200 font-mono text-sm text-center text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-200 tracking-widest"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* All staff PINs */}
      <div>
        <h3 className="font-bebas text-lg tracking-[2px] text-gray-800 mb-1">STAFF PIN CODES</h3>
        <p className="font-mono text-[11px] text-gray-400 mb-3">4-digit PINs for staff portal access.</p>
        <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
          {allStaff.map((m, idx) => (
            <PinRow key={m.id} m={m} borderBottom={idx < allStaff.length - 1} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main Blueprint screen ─────────────────────────────────────────────────────
export default function BlueprintScreen() {
  const { dispatch } = useApp();
  const [unlocked, setUnlocked] = useState(false);
  const [active, setActive] = useState<BlueprintSection>('staff-management');
  const activeItem = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === active);

  // PIN gate — require admin PIN (Kayla) to access Blueprint. Cancelling the PIN modal
  // routes the user back to the Queue tab; previously onCancel just re-asserted unlocked=false,
  // leaving the user stuck on the PIN prompt with no way out except entering the right PIN.
  if (!unlocked) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-gray-50/50">
        <div className="w-16 h-16 rounded-2xl bg-pink-50 flex items-center justify-center mb-4">
          <KeyRound size={28} className="text-pink-400" />
        </div>
        <h2 className="font-bebas text-2xl tracking-[3px] text-gray-800 mb-1">BLUEPRINT</h2>
        <p className="font-mono text-xs text-gray-400 mb-6">Admin access required</p>
        <PinVerifyModal
          isOpen={true}
          title="Enter Admin PIN"
          onSuccess={() => setUnlocked(true)}
          onCancel={() => dispatch({ type: 'SET_VIEW', view: 'queue' })}
        />
      </div>
    );
  }

  function renderContent() {
    switch (active) {
      case 'staff-management': return <StaffScreen />;
      case 'staff-schedule':   return <StaffScheduleScreen />;
      case 'staff-group':      return <StaffGroupScreen />;
      case 'block-time':       return <CalendarScreen />;
      case 'security':         return <SecurityScreen />;
      case 'services':         return <ServicesScreen />;
      case 'criteria':         return <CriteriaScreen />;
      default: return null;
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Sidebar ──────────────────────────────────────────────────────────── */}
      <div className="w-64 flex-shrink-0 bg-white border-r border-gray-100 overflow-y-auto flex flex-col">
        <div className="px-5 pt-5 pb-4 border-b border-gray-50">
          <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">BLUEPRINT</h2>
          <p className="font-mono text-[11px] text-gray-400 mt-0.5">Salon configuration</p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.heading}>
              <p className="font-mono text-[10px] font-bold text-gray-400 tracking-[2px] px-3 mb-2">{group.heading}</p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const isActive = active === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActive(item.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${isActive ? 'bg-pink-50 text-pink-600' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}
                    >
                      <Icon size={15} className="flex-shrink-0" />
                      <span className="font-mono text-[13px] font-semibold flex-1">{item.label}</span>
                      {isActive && <ChevronRight size={12} className="flex-shrink-0 text-pink-400" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
        {activeItem && (
          <div className="flex-shrink-0 bg-white border-b border-gray-100 px-6 py-3 flex items-center gap-3">
            <activeItem.icon size={16} className="text-pink-400 flex-shrink-0" />
            <div>
              <h3 className="font-bebas text-lg tracking-[2px] text-gray-800 leading-none">{activeItem.label.toUpperCase()}</h3>
              <p className="font-mono text-[10px] text-gray-400 mt-0.5">{activeItem.description}</p>
            </div>
          </div>
        )}
        {/* overflow-y-auto on this wrapper lets sub-screens that don't define their own
            scroll (Services, Criteria, Calendar) scroll their content here. Screens that
            do define their own scroll (Staff, StaffSchedule, StaffGroup, Security) still
            work because their h-full fits within this wrapper's bounded height — their
            inner overflow handles their own scroll without producing a nested scrollbar. */}
        <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50/30">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
