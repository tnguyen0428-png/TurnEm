import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import ClientForm from './ClientForm';
import type { ClientFormData } from './ClientForm';
import type { QueueEntry } from '../../types';
import { upsertCustomerFromIntake, splitClientName } from '../../lib/customers';

export default function AddClientModal() {
  const { state, dispatch } = useApp();

  function handleSubmit(data: ClientFormData) {
    // ClientForm stamps clientRequest === true on every entry it emits.
    // Filter on that flag so only real customer requests count.
    const hasAnyRequest = data.serviceRequests.some((r) => r.clientRequest === true && r.manicuristIds.length > 0);
    const firstRequestedId = data.serviceRequests.find((r) => r.clientRequest === true && r.manicuristIds.length > 0)?.manicuristIds[0] ?? null;

    const newClient: QueueEntry = {
      id: crypto.randomUUID(),
      clientName: data.clientName,
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
    const { firstName, lastName } = splitClientName(data.clientName);
    void upsertCustomerFromIntake({ firstName, lastName });
  }

  return (
    <Modal title="ADD CLIENT" onClose={() => dispatch({ type: 'SET_MODAL', modal: null })}>
      <ClientForm
        salonServices={state.salonServices}
        manicurists={state.manicurists}
        submitLabel="ADD TO QUEUE"
        onSubmit={handleSubmit}
      />
    </Modal>
  );
}
