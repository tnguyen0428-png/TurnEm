import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Users, Shield, Sparkles, Scale, CalendarDays, UsersRound,
  Clock3, ChevronRight, GripVertical, KeyRound, Lock, X,
  DollarSign, UserCheck, Gift, UserPlus,
} from 'lucide-react';
import SalesReport from './SalesReport';
import StaffReport from './StaffReport';
import GiftCertificatesReport from './GiftCertificatesReport';
import CustomersScreen from './CustomersScreen';
import { supabase } from '../../lib/supabase';
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
  | 'criteria'
  | 'reports-sales'
  | 'reports-staff'
  | 'reports-gift-certs'
  | 'customers';

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
  {
    heading: 'CUSTOMERS',
    items: [
      { id: 'customers', label: 'Customer Profiles', icon: UserPlus, description: 'Search and edit customer info, history, notes' },
    ],
  },
  {
    heading: 'REPORTS',
    items: [
      { id: 'reports-sales',        label: 'Sales',              icon: DollarSign, description: 'Daily / weekly sales totals and payment mix' },
      { id: 'reports-staff',        label: 'Staff',              icon: UserCheck,  description: 'Manicurist sales + receptionist hours' },
      { id: 'reports-gift-certs',   label: 'Gift Certificates',  icon: Gift,       description: 'Open + used gift certs, searchable by serial' },
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

      <div className="flex justify-center py-3.5">
        <button
          onClick={() => onToggleBook(!inBook)}
          className={`w-10 h-6 rounded-full transition-all relative flex-shrink-0 ${inBook ? 'bg-pink-500' : 'bg-gray-200'}`}
        >
          <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${inBook ? 'left-4' : 'left-0.5'}`} />
        </button>
      </div>

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
        <div className="grid bg-gray-50 border-b border-gray-100" style={{ gridTemplateColumns: '1fr 130px 150px' }}>
          <div className="px-4 py-3 font-mono text-[10px] font-bold text-gray-400 tracking-wider">STAFF MEMBER</div>
          <div className="py-3 text-center font-mono text-[10px] font-bold text-pink-400 tracking-wider">MANICURIST</div>
          <div className="py-3 text-center font-mono text-[10px] font-bold text-indigo-400 tracking-wider">RECEPTIONIST</div>
        </div>

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

// ─── Dual-mode PIN gate ────────────────────────────────────────────────────────
// Single PIN field that accepts either the admin PIN (full access) or a
// receptionist's personal PIN (Customer Profiles only).

async function fetchAdminPasscode(): Promise<string | null> {
  const { data, error } = await supabase
    .from('system_state')
    .select('admin_passcode')
    .eq('id', 'singleton')
    .maybeSingle();
  if (error || !data) return null;
  return (data.admin_passcode as string) || null;
}

function BlueprintPinGate({
  receptionists, onSuccess, onCancel,
}: {
  receptionists: Manicurist[];
  onSuccess: (tier: 'admin' | 'receptionist') => void;
  onCancel: () => void;
}) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => pinRef.current?.focus(), 50);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pin) return;
    setError('');
    setLoading(true);
    try {
      const adminPin = await fetchAdminPasscode();
      if (adminPin && pin === adminPin) {
        onSuccess('admin');
        return;
      }
      const match = receptionists.find((r) => r.pinCode && r.pinCode === pin);
      if (match) {
        onSuccess('receptionist');
        return;
      }
      setError('Incorrect PIN');
      setPin('');
      setTimeout(() => pinRef.current?.focus(), 0);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
              <Lock size={18} className="text-gray-600" />
            </div>
            <h2 className="font-bebas text-2xl tracking-[1.5px] text-gray-900">Enter PIN</h2>
          </div>
          <button type="button" onClick={onCancel} className="text-gray-400 hover:text-gray-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <input
            ref={pinRef}
            type="password"
            inputMode="numeric"
            pattern="[0-9]*"
            value={pin}
            onChange={(e) => { setPin(e.target.value); setError(''); }}
            className={`w-full px-4 py-3 rounded-xl border font-mono text-lg text-center tracking-widest focus:outline-none ${
              error ? 'border-red-300 bg-red-50 text-red-600' : 'border-gray-200 text-gray-900 focus:border-gray-400'
            }`}
            placeholder="PIN"
            autoComplete="off"
          />
          {error && <p className="mt-2 font-mono text-xs text-red-500 text-center">{error}</p>}
          <p className="mt-3 font-mono text-[10px] text-gray-400 text-center leading-relaxed">
            Admin PIN → full Blueprint · Receptionist PIN → Customer Profiles only
          </p>
          <div className="flex gap-2 mt-4">
            <button type="button" onClick={onCancel}
              className="flex-1 py-2.5 rounded-xl border border-gray-200 text-gray-600 font-mono text-xs font-semibold">
              CANCEL
            </button>
            <button type="submit" disabled={loading || !pin}
              className="flex-1 py-2.5 rounded-xl bg-gray-900 text-white font-mono text-xs font-semibold disabled:opacity-50">
              {loading ? 'CHECKING...' : 'UNLOCK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Blueprint screen ─────────────────────────────────────────────────────
type AccessTier = 'admin' | 'receptionist';

export default function BlueprintScreen() {
  const { state, dispatch } = useApp();
  const [accessTier, setAccessTier] = useState<AccessTier | null>(null);
  const [active, setActive] = useState<BlueprintSection>('staff-management');

  const receptionists = useMemo(
    () => state.manicurists.filter((m) => m.isReceptionist),
    [state.manicurists],
  );

  const visibleNavGroups = useMemo(() => {
    if (accessTier === 'admin') return NAV_GROUPS;
    if (accessTier === 'receptionist') return NAV_GROUPS.filter((g) => g.heading === 'CUSTOMERS');
    return [];
  }, [accessTier]);

  const visibleSectionIds = useMemo(
    () => new Set(visibleNavGroups.flatMap((g) => g.items.map((i) => i.id))),
    [visibleNavGroups],
  );

  useEffect(() => {
    if (accessTier === 'receptionist') {
      setActive('customers');
    } else if (accessTier === 'admin' && !visibleSectionIds.has(active)) {
      setActive('staff-management');
    }
  }, [accessTier, visibleSectionIds, active]);

  const activeItem = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.id === active);

  if (accessTier === null) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-gray-50/50">
        <div className="w-16 h-16 rounded-2xl bg-pink-50 flex items-center justify-center mb-4">
          <KeyRound size={28} className="text-pink-400" />
        </div>
        <h2 className="font-bebas text-2xl tracking-[3px] text-gray-800 mb-1">BLUEPRINT</h2>
        <p className="font-mono text-xs text-gray-400 mb-1">
          Admin PIN unlocks everything · Receptionist PIN unlocks Customer Profiles
        </p>
        <BlueprintPinGate
          receptionists={receptionists}
          onSuccess={setAccessTier}
          onCancel={() => dispatch({ type: 'SET_VIEW', view: 'queue' })}
        />
      </div>
    );
  }

  function renderContent() {
    if (!visibleSectionIds.has(active)) return null;
    switch (active) {
      case 'staff-management': return <StaffScreen />;
      case 'staff-schedule':   return <StaffScheduleScreen />;
      case 'staff-group':      return <StaffGroupScreen />;
      case 'block-time':       return <CalendarScreen />;
      case 'security':         return <SecurityScreen />;
      case 'services':         return <ServicesScreen />;
      case 'criteria':         return <CriteriaScreen />;
      case 'reports-sales':        return <SalesReport />;
      case 'reports-staff':        return <StaffReport />;
      case 'reports-gift-certs':   return <GiftCertificatesReport />;
      case 'customers':            return <CustomersScreen />;
      default: return null;
    }
  }

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-64 flex-shrink-0 bg-white border-r border-gray-100 overflow-y-auto flex flex-col">
        <div className="px-5 pt-5 pb-4 border-b border-gray-50">
          <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">BLUEPRINT</h2>
          <p className="font-mono text-[11px] text-gray-400 mt-0.5">
            {accessTier === 'receptionist' ? 'Receptionist · Customer Profiles' : 'Salon configuration'}
          </p>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-6">
          {visibleNavGroups.map((group) => (
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
        <div className="flex-1 min-h-0 overflow-y-auto bg-gray-50/30">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
