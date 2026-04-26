import { useMemo } from 'react';
import Modal from '../shared/Modal';
import { useApp } from '../../state/AppContext';
import ClientForm from './ClientForm';
import type { ClientFormData } from './ClientForm';

export default function EditClientModal() {
  const { state, dispatch } = useApp();

  const client = state.queue.find((c) => c.id === state.editingClientId);

  // Hooks must run in the same order every render. If the client gets removed
  // from the queue while the modal is open (delete from another tab, complete
  // service, etc.), `client` becomes undefined; we must still call useMemo
  // before any early return. The memo body short-circuits when client is null.
  const initialSelectedServices = useMemo(() => {
    if (!client) return [];
    // Track how many times each service name has been mapped so that when a client
    // has the same service multiple times (e.g. 3x Gel Pedicure) and only some of them
    // have a manicurist request, we assign the request to the correct instance rather
    // than spreading it across all instances of that service.
    const requestIndexMap = new Map<string, number>();

    return client.services.map((serviceName) => {
      const svc = state.salonServices.find((s) => s.name === serviceName);
      // Only pre-fill from real customer requests (clientRequest === true).
      // Otherwise legacy column-placement entries from the appointment book
      // would silently get promoted to client requests on save.
      const req = (client.serviceRequests || []).find(
        (r) => r.service === serviceName && r.clientRequest === true
      );

      const currentIndex = requestIndexMap.get(serviceName) ?? 0;
      requestIndexMap.set(serviceName, currentIndex + 1);

      let requestedManicuristIds: string[] = [];
      if (req && req.manicuristIds.length > 0 && currentIndex < req.manicuristIds.length) {
        requestedManicuristIds = [req.manicuristIds[currentIndex]];
      }

      return {
        serviceId: svc?.id || '',
        serviceName,
        turnValue: svc?.turnValue ?? 0.5,
        requestedManicuristIds,
      };
    });
  }, [client, state.salonServices]);

  if (!client) return null;

  const clientId = client.id;

  function handleClose() {
    dispatch({ type: 'SET_EDITING_CLIENT', clientId: null });
    dispatch({ type: 'SET_MODAL', modal: null });
  }

  function handleSubmit(data: ClientFormData) {
    // ClientForm now stamps clientRequest === true on every entry it emits,
    // so any entry with manicuristIds is a genuine request.
    const hasAnyRequest = data.serviceRequests.some((r) => r.clientRequest === true && r.manicuristIds.length > 0);
    const firstRequestedId = data.serviceRequests.find((r) => r.clientRequest === true && r.manicuristIds.length > 0)?.manicuristIds[0] ?? null;

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
