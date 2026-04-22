import { useState } from 'react';
import { Users, ClipboardList, Clock, CalendarCheck, Sparkles, Scale, CalendarDays, LogOut, KeyRound } from 'lucide-react';
import type { ViewType } from '../../types';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../state/AuthContext';
import { PinVerifyModal, ChangePinModal } from '../shared/AdminPinGate';

const TABS: { id: ViewType; label: string; icon: typeof Users }[] = [
  { id: 'queue', label: 'QUEUE', icon: ClipboardList },
  { id: 'appointments', label: 'APPTS', icon: CalendarCheck },
  { id: 'staff', label: 'STAFF', icon: Users },
  { id: 'services', label: 'SERVICES', icon: Sparkles },
  { id: 'criteria', label: 'CRITERIA', icon: Scale },
  { id: 'calendar', label: 'CALENDAR', icon: CalendarDays },
  { id: 'history', label: 'HISTORY', icon: Clock },
];

const PROTECTED_TABS: ViewType[] = ['staff', 'services', 'criteria', 'calendar'];

export default function TabBar() {
  const { state, dispatch } = useApp();
  const { user, signOut } = useAuth();
  const [pendingView, setPendingView] = useState<ViewType | null>(null);
  const [showChangePin, setShowChangePin] = useState(false);

  function handleTabClick(viewId: ViewType) {
    if (PROTECTED_TABS.includes(viewId) && viewId !== state.view) {
      setPendingView(viewId);
    } else {
      dispatch({ type: 'SET_VIEW', view: viewId });
    }
  }

  return (
    <>
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center flex-shrink-0">
              <img
                src="/Turn_Em_Logo.jpg"
                alt="Turn Em"
                className="h-44 w-auto mix-blend-multiply contrast-[1.2] brightness-[1.05] scale-125 origin-left"
              />
            </div>
            <div className="flex items-center gap-1 flex-wrap flex-1 min-w-0 justify-center">
              {TABS.map((tab) => {
                const isActive = state.view === tab.id;
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => handleTabClick(tab.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-bebas text-sm tracking-[1.2px] transition-all duration-200 whitespace-nowrap ${
                      isActive
                        ? 'bg-pink-50 text-pink-600'
                        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <Icon size={15} />
                    <span className="hidden sm:inline">{tab.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => setShowChangePin(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-gray-500 hover:text-indigo-500 hover:border-indigo-200 hover:bg-indigo-50 font-mono text-xs font-semibold transition-all max-w-[220px]"
                title="Change admin PIN"
              >
                <KeyRound size={14} className="flex-shrink-0" />
                <span className="truncate">
                  ADMIN
                </span>
              </button>
              <button
                onClick={signOut}
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-200 hover:bg-red-50 font-mono text-xs font-semibold transition-all"
                title="Sign out"
              >
                <LogOut size={14} />
                <span className="hidden sm:inline">LOGOUT</span>
              </button>
            </div>
          </div>
        </div>
      </nav>
      <PinVerifyModal
        isOpen={pendingView !== null}
        onSuccess={() => {
          if (pendingView) dispatch({ type: 'SET_VIEW', view: pendingView });
          setPendingView(null);
        }}
        onCancel={() => setPendingView(null)}
      />
      <ChangePinModal isOpen={showChangePin} onClose={() => setShowChangePin(false)} />
    </>
  );
}
