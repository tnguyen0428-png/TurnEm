import { ClipboardList, Clock, CalendarCheck, Settings2, LogOut, Receipt } from 'lucide-react';
import type { ViewType } from '../../types';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../state/AuthContext';

const TABS: { id: ViewType; label: string; icon: typeof ClipboardList }[] = [
  { id: 'queue',        label: 'QUEUE',     icon: ClipboardList },
  { id: 'appointments', label: 'APPTS',     icon: CalendarCheck },
  { id: 'register',     label: 'REGISTER',  icon: Receipt },
  { id: 'blueprint',   label: 'BLUEPRINT', icon: Settings2 },
  { id: 'history',      label: 'HISTORY',   icon: Clock },
];

export default function TabBar() {
  const { state, dispatch } = useApp();
  const { user, signOut } = useAuth();

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-28 sm:h-48">
          <div className="flex items-center flex-shrink-0">
            <img
              src="/Turn_Em_Logo.png"
              alt="Turn Em"
              className="h-24 w-auto sm:h-44"
            />
          </div>
          <div className="flex items-center gap-0.5 overflow-x-auto hide-scrollbar">
            {TABS.map((tab) => {
              const blueprintViews = ['blueprint', 'staff', 'services', 'criteria', 'calendar'];
              const isActive = tab.id === 'blueprint'
                ? blueprintViews.includes(state.view)
                : state.view === tab.id;
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => dispatch({ type: 'SET_VIEW', view: tab.id })}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md font-bebas text-sm tracking-[1.2px] transition-all duration-200 whitespace-nowrap flex-shrink-0 ${
                    isActive
                      ? 'bg-pink-50 text-pink-600'
                      : 'text-gray-400 hover:text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <Icon size={15} />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            {user && (
              <span className="font-mono text-xs text-gray-400 hidden md:block truncate max-w-[160px]">
                {user.email}
              </span>
            )}
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
  );
}
