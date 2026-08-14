import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../state/AppContext';
import { SingleServiceAssign } from './SingleServiceAssign';
import { MultiServiceAssign } from './MultiServiceAssign';
import CustomerNoteAlert from '../shared/CustomerNoteAlert';
import { getPermanentNoteByPhone } from '../../lib/customers';

export default function AssignModal() {
  const { state } = useApp();
  const client = state.queue.find((c) => c.id === state.selectedClient);
  const clientId = client?.id ?? null;

  // Surface the client's notes at ASSIGN time as well as at check-in. The
  // person picking the manicurist is often not the one who checked the client
  // in, and the note is usually about who should (or shouldn't) take them, or
  // how long they have — which is exactly the decision being made here. Shows
  // the permanent note and this booking's note together; see CustomerNoteAlert
  // for why both matter. Covers SingleServiceAssign and MultiServiceAssign in
  // one place because AssignModal is the only route into either.
  const [noteAlert, setNoteAlert] = useState<{ name: string; note: string; apptNote: string } | null>(null);
  // Fire once per open. This component is mounted conditionally by App
  // (`state.modal === 'assignConfirm'`), so the ref resets every time the
  // modal is opened — reopening for the same client shows the note again,
  // while queue re-renders while it's open do not.
  const shownForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!clientId) return;
    if (shownForRef.current === clientId) return;
    shownForRef.current = clientId;
    const entry = state.queue.find((c) => c.id === clientId);
    if (!entry) return;
    const appt = entry.originalAppointment;
    const apptNote = (appt?.notes ?? '').trim();
    let cancelled = false;
    // Walk-ins have no linked appointment and usually no phone on the queue
    // entry, so this simply resolves to null and nothing pops.
    void getPermanentNoteByPhone(appt?.clientPhone).then((hit) => {
      if (cancelled) return;
      if (hit || apptNote) {
        setNoteAlert({
          name: hit?.name ?? entry.clientName,
          note: hit?.note ?? '',
          apptNote,
        });
      }
    });
    return () => { cancelled = true; };
    // state.queue is read inside but intentionally not a dependency: the alert
    // should be decided once when the modal opens, not re-evaluated on every
    // queue tick while the receptionist is choosing a manicurist.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  if (!client) return null;

  return (
    <>
      {client.services.length > 1
        ? <MultiServiceAssign client={client} />
        : <SingleServiceAssign client={client} />}
      {noteAlert && (
        <CustomerNoteAlert
          name={noteAlert.name}
          note={noteAlert.note}
          apptNote={noteAlert.apptNote}
          onDismiss={() => setNoteAlert(null)}
        />
      )}
    </>
  );
}
