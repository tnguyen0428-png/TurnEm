import { useApp } from '../../state/AppContext';
import { SingleServiceAssign } from './SingleServiceAssign';
import { MultiServiceAssign } from './MultiServiceAssign';

export default function AssignModal() {
  const { state } = useApp();
  const client = state.queue.find((c) => c.id === state.selectedClient);
  if (!client) return null;
  if (client.services.length > 1) return <MultiServiceAssign client={client} />;
  return <SingleServiceAssign client={client} />;
}
