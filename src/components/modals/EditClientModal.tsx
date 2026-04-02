import { useMemo } from 'react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import ClientForm from './ClientForm';
import type { ClientFormData } from './ClientForm';

export default function EditClientModal() {
  const { state, dispatch } = useApp();

  const client = state.queue.find((c) => c.id === state.editingClientId);
  if (!client) return null;

  const clientId = client.id;

  const initialSelectedServices = useMemo(() => {
    return client.services.map((serviceName) => {
      const svc = state.salonServices.find((s) => s.name === serviceName);
      const req = (client.serviceRequests || []).find((r) => r.service === serviceName);
      return {
        serviceId: svc?.id || '',
        serviceName,
        turnValue: svc?.turnValue ?? 0.5,
        requestedManicuristIds: req?.manicuristIds || [],
      };
    });
  }, [client, state.salonServices]);

  function handleClose() {
    dispatch({ type: 'SET_EDITING_CLIENT', clientId: null });
    dispatch({ type: 'SET_MODAL', modal: null });
  }

  function handleSubmit(data: ClientFormData) {
    const hasAnyRequest = data.serviceRequests.some((r) => r.manicuristIds.length > 0);
    const firstRequestedId = data.serviceRequests.find((r) => r.manicuristIds.length > 0)?.manicuristIds[0] ?? null;

    dispatch({
      type: 'UPDATE_CLIENT',
      id: clientId,
      updates: {
        clientName: data.clientName,
        services: data.services,
        turnValue: data.turnValue,
        serviceRequests: data.serviceRequests,
        requestedManicuristId: firstRequestedId,
        isRequested: hasAnyRequest,
        isAppointment: data.isAppointment,
      },
    });
    handleClose();
  }

  return (
    <Modal title="EDIT CLIENT" onClose={handleClose}>
      <ClientForm
        initialName={client.clientName}
        initialIsAppointment={client.isAppointment}
        initialSelectedServices={initialSelectedServices}
        salonServices={state.salonServices}
        manicurists={state.manicurists}
        submitLabel="SAVE CHANGES"
        onSubmit={handleSubmit}
      />
    </Modal>
  );
}
