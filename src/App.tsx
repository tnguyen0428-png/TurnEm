import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './state/AuthContext';
import { AppProvider, useApp } from './state/AppContext';
import TabBar from './components/layout/TabBar';
import LoginScreen from './components/auth/LoginScreen';
import QueueScreen from './components/queue/QueueScreen';
import HistoryScreen from './components/history/HistoryScreen';
import AppointmentsScreen from './components/appointments/AppointmentsScreen';
import BlueprintScreen from './components/blueprint/BlueprintScreen';
import AddClientModal from './components/modals/AddClientModal';
import EditClientModal from './components/modals/EditClientModal';
import AssignModal from './components/modals/AssignModal';
import StaffModal from './components/modals/StaffModal';
import AppointmentModal from './components/modals/AppointmentModal';
import SmsToast from './components/shared/SmsToast';
import StaffLoginScreen from './components/staff/StaffLoginScreen';
import StaffPortalScreen from './components/staff/StaffPortalScreen';
import { Loader2 } from 'lucide-react';
import type { Manicurist } from './types';

function AppContent() {
  const { state, syncError, clearSyncError, saveStatus } = useApp();

  if (!state.loaded) {
    return (
      <div className="min-h-screen bg-[#fafafa] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-pink-500 animate-spin" />
          <p className="font-mono text-sm text-gray-400">Loading salon...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#fafafa] flex flex-col overflow-hidden">
      {syncError && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: '#dc2626',
          color: 'white',
          padding: '10px 16px',
          fontSize: '14px',
          fontWeight: 600,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          ⚠️ {syncError}
          <button onClick={clearSyncError} style={{ background: 'none', border: 'none', color: 'white', fontSize: '18px', cursor: 'pointer' }}>✕</button>
        </div>
      )}
      {!syncError && (saveStatus === 'saving' || saveStatus === 'saved') && (
        <div style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          zIndex: 9999,
          background: saveStatus === 'saving' ? '#1f2937' : '#10b981',
          color: 'white',
          padding: '8px 14px',
          borderRadius: 999,
          fontSize: 12,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontWeight: 600,
          letterSpacing: '0.05em',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          transition: 'opacity 200ms ease',
        }}>
          {saveStatus === 'saving' ? (
            <>
              <span style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                borderRadius: '50%',
                border: '2px solid rgba(255,255,255,0.3)',
                borderTopColor: 'white',
                animation: 'turnem-spin 0.8s linear infinite',
              }} />
              SAVING…
            </>
          ) : (
            <>✓ SAVED</>
          )}
        </div>
      )}
      <style>{`@keyframes turnem-spin { to { transform: rotate(360deg); } }`}</style>
      <TabBar />
      <main className="flex-1 overflow-hidden">
        {state.view === 'queue' && <QueueScreen />}
        {state.view === 'history' && <HistoryScreen />}
        {state.view === 'appointments' && <AppointmentsScreen />}
        {(state.view === 'blueprint' || state.view === 'staff' || state.view === 'services' || state.view === 'criteria' || state.view === 'calendar') && <BlueprintScreen />}
      </main>

      {state.modal === 'addClient' && <AddClientModal />}
      {state.modal === 'editClient' && <EditClientModal />}
      {state.modal === 'assignConfirm' && <AssignModal />}
      {state.modal === 'addStaff' && <StaffModal mode="add" />}
      {state.modal === 'editStaff' && <StaffModal mode="edit" />}
      {state.modal === 'addAppointment' && <AppointmentModal mode="add" />}
      {state.modal === 'editAppointment' && <AppointmentModal mode="edit" />}

      <SmsToast />
    </div>
  );
}

function AuthGate() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fafafa] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-pink-500 animate-spin" />
          <p className="font-mono text-sm text-gray-400">Checking session...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}

function StaffPortal() {
  const { state } = useApp();
  const [loggedInManicurist, setLoggedInManicurist] = useState<Manicurist | null>(null);
  const [checked, setChecked] = useState(false);

  // Restore saved login AFTER state has loaded (manicurists are available)
  useEffect(() => {
    if (!state.loaded) return;
    const savedId = localStorage.getItem('turnem_staff_id');
    if (savedId) {
      const found = state.manicurists.find((m) => m.id === savedId) || null;
      setLoggedInManicurist(found);
    }
    setChecked(true);
  }, [state.loaded, state.manicurists]);

  if (!state.loaded || !checked) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
          <p className="font-mono text-sm text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  if (!loggedInManicurist) {
    return (
      <StaffLoginScreen
        manicurists={state.manicurists}
        onLogin={(m) => {
          localStorage.setItem('turnem_staff_id', m.id);
          setLoggedInManicurist(m);
        }}
      />
    );
  }

  return (
    <StaffPortalScreen
      manicurist={loggedInManicurist}
      onLogout={() => {
        localStorage.removeItem('turnem_staff_id');
        setLoggedInManicurist(null);
      }}
    />
  );
}

export default function App() {
  const isStaffMode = new URLSearchParams(window.location.search).get('mode') === 'staff' || (window as any).__TURNEM_STAFF_MODE__ === true;

  if (isStaffMode) {
    return (
      <AppProvider>
        <StaffPortal />
      </AppProvider>
    );
  }

  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
