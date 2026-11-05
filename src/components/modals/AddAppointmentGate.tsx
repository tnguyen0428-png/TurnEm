// AddAppointmentGate — every new booking passes the receptionist PIN before
// the form opens, so Appointment.bookedByReceptionistId is never blank.
//
// The appointment book grid already gates its own double-click and seeds the
// draft with bookedByReceptionistId; those drafts go straight through. The
// paths that didn't — BOOK APPT inside a ticket, book-next on the closed-ticket
// list, and the NEW button on the Appointments list — were saving bookings
// with no one on record (Tony 2026-11-04). Gating here instead of at each
// button means any future "book" entry point is covered too.

import { lazy } from 'react';
import { useApp } from '../../state/AppContext';
import ReceptionistPinGate from '../shared/ReceptionistPinGate';

const AppointmentModal = lazy(() => import('./AppointmentModal'));

export default function AddAppointmentGate() {
  const { state, dispatch } = useApp();
  const draft = state.appointmentDraft;

  if (draft?.bookedByReceptionistId) {
    return <AppointmentModal mode="add" />;
  }

  const clientName = [draft?.clientFirstName, draft?.clientLastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  return (
    <ReceptionistPinGate
      open
      title="BOOK APPOINTMENT"
      subtitle={
        clientName
          ? `Enter your PIN to book ${clientName}.`
          : 'Enter your PIN to open a new booking.'
      }
      confirmLabel="OPEN"
      tone="primary"
      pinOnly
      receptionists={state.manicurists.filter((m) => m.isReceptionist)}
      onCancel={() => {
        dispatch({ type: 'SET_APPOINTMENT_DRAFT', draft: null });
        dispatch({ type: 'SET_MODAL', modal: null });
      }}
      onConfirm={(receptionistId) => {
        // Keep the pre-fill (client, phone, date) and add who's booking.
        dispatch({
          type: 'SET_APPOINTMENT_DRAFT',
          draft: { ...(draft ?? {}), bookedByReceptionistId: receptionistId },
        });
      }}
    />
  );
}
