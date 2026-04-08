import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import ClientForm from './ClientForm';
import type { ClientFormData } from './ClientForm';
import type { QueueEntry } from '../../types';

export default function AddClientModal() {
  const { state, dispatch } = useApp();

  function handleSubmit(data: ClientFormData) {
    const hasAnyRequest = data.serviceRequests.some((r) => r.manicuristIds.length > 0);
    const firstRequestedId = data.serviceRequests.find((r) => r.manicuristIds.length > 0)?.manicuristIds[0] ?? null;

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
    };

    dispatch({ type: 'ADD_CLIENT', client: newClient });
    dispatch({ type: 'SET_MODAL', modal: null });
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
