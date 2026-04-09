import { AuthProvider, useAuth } from './state/AuthContext';
import { AppProvider, useApp } from './state/AppContext';
import TabBar from './components/layout/TabBar';
import LoginScreen from './components/auth/LoginScreen';
import QueueScreen from './components/queue/QueueScreen';
import StaffScreen from './components/staff/StaffScreen';
import HistoryScreen from './components/history/HistoryScreen';
import AppointmentsScreen from './components/appointments/AppointmentsScreen';
import ServicesScreen from './components/services/ServicesScreen';
import CriteriaScreen from './components/criteria/CriteriaScreen';
import CalendarScreen from './components/calendar/CalendarScreen';
import AddClientModal from './components/modals/AddClientModal';
import EditClientModal from './components/modals/EditClientModal';
import AssignModal from './components/modals/AssignModal';
import StaffModal from './components/modals/StaffModal';
import AppointmentModal from './components/modals/AppointmentModal';
import SmsToast from './components/shared/SmsToast';
import { Loader2 } from 'lucide-react';

function AppContent() {
  const { state, syncError, clearSyncError } = useApp();

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
    <div className="min-h-screen bg-[#fafafa] flex flex-col">
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
      <TabBar />
      <main className="flex-1 overflow-hidden">
        {state.view === 'queue' && <QueueScreen />}
        {state.view === 'staff' && <StaffScreen />}
        {state.view === 'history' && <HistoryScreen />}
        {state.view === 'appointments' && <AppointmentsScreen />}
        {state.view === 'services' && <ServicesScreen />}
        {state.view === 'criteria' && <CriteriaScreen />}
        {state.view === 'calendar' && <CalendarScreen />}
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

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
