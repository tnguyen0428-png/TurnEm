import { useState } from 'react';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import ClientForm from './ClientForm';
import type { ClientFormData } from './ClientForm';
import type { QueueEntry } from '../../types';
import { upsertCustomerFromIntake, splitClientName } from '../../lib/customers';
import { getLocalDateStr } from '../../utils/time';
import { dedupeClientName } from '../../utils/clientNaming';

export default function AddClientModal() {
  const { state, dispatch } = useApp();
  // Pending duplicate-name confirmation. When the cashier types a name that
  // exactly matches an in-salon client (today's queue or today's completed),
  // we stash the form data + the auto-numbered suggestion here and render
  // the ConfirmDialog. Cleared on confirm OR cancel.
  const [pendingDup, setPendingDup] = useState<{
    data: ClientFormData;
    suggestedName: string;
  } | null>(null);

  function commit(data: ClientFormData, overrideName?: string) {
    const clientName = overrideName ?? data.clientName;
    // ClientForm stamps clientRequest === true on every entry it emits.
    // Filter on that flag so only real customer requests count.
    const hasAnyRequest = data.serviceRequests.some((r) => r.clientRequest === true && r.manicuristIds.length > 0);
    const firstRequestedId = data.serviceRequests.find((r) => r.clientRequest === true && r.manicuristIds.length > 0)?.manicuristIds[0] ?? null;

    const newClient: QueueEntry = {
      id: crypto.randomUUID(),
      clientName,
      services: data.services,
      turnValue: data.turnValue,
      serviceRequests: data.serviceRequests,
      requestedManicuristId: firstRequestedId,
      isRequested: hasAnyRequest,
      isAppointment: data.isAppointment,
      assignedManicuristId: null,
      status: 'waiting',
      arrivedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      extraTimeMs: 0,
    };

    dispatch({ type: 'ADD_CLIENT', client: newClient });
    dispatch({ type: 'SET_MODAL', modal: null });
    // Fire-and-forget customer profile upsert so the Blueprint → Customers
    // list auto-fills as the salon takes walk-ins. Failure is non-blocking;
    // the queue entry is already saved by the dispatch above.
    const { firstName, lastName } = splitClientName(clientName);
    void upsertCustomerFromIntake({ firstName, lastName });
  }

  function handleSubmit(data: ClientFormData) {
    const entered = data.clientName.trim();
    if (entered) {
      // "In-salon today" = currently in the queue (waiting / inProgress) +
      // anything completed today. Both are visible to the cashier in the
      // floor view, so a name collision here is genuinely a name the
      // cashier is about to see twice.
      const today = getLocalDateStr(new Date());
      const queueNames = state.queue.map((q) => q.clientName);
      const completedToday = state.completed
        .filter((c) => {
          if (c.voided) return false;
          // completedAt may be null for an open-ticket assignment that
          // hasn't been finalized — those are still "in salon", so include
          // them. For dated completions, filter to today's LA date.
          if (c.completedAt == null) return true;
          return getLocalDateStr(new Date(c.completedAt)) === today;
        })
        .map((c) => c.clientName);
      // Also count today's booked appointments (scheduled / checked-in /
      // completed) as "in salon today" — otherwise a second walk-in named
      // "Christy" wouldn't be numbered when the first Christy is an
      // appointment that hasn't reached the floor yet. Cancelled / no-show
      // appts are excluded since that person isn't actually coming in.
      const apptNamesToday = state.appointments
        .filter((a) => a.date === today && a.status !== 'cancelled' && a.status !== 'no-show')
        .map((a) => a.clientName);
      const allInSalon = [...queueNames, ...completedToday, ...apptNamesToday];
      // `entered` is already trimmed; dedupeClientName returns it unchanged
      // when there's no collision, or the next "Name N" when there is.
      const suggested = dedupeClientName(entered, allInSalon);
      if (suggested !== entered) {
        setPendingDup({ data, suggestedName: suggested });
        return;
      }
    }
    commit(data);
  }

  return (
    <>
      <Modal title="ADD CLIENT" onClose={() => dispatch({ type: 'SET_MODAL', modal: null })}>
        <ClientForm
          salonServices={state.salonServices}
          manicurists={state.manicurists}
          submitLabel="ADD TO QUEUE"
          onSubmit={handleSubmit}
        />
      </Modal>
      {pendingDup && (
        <ConfirmDialog
          message={`A client named "${pendingDup.data.clientName.trim()}" is already in the salon. Save as "${pendingDup.suggestedName}"?`}
          confirmLabel={`Save as ${pendingDup.suggestedName}`}
          onConfirm={() => {
            const { data, suggestedName } = pendingDup;
            setPendingDup(null);
            commit(data, suggestedName);
          }}
          onCancel={() => setPendingDup(null)}
        />
      )}
    </>
  );
}
