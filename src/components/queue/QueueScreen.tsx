import { useApp } from '../../state/AppContext';
import { getPriorityQueue } from '../../utils/priority';
import WaitingPanel from './WaitingPanel';
import ManicuristPanel from './ManicuristPanel';

export default function QueueScreen() {
  const { state } = useApp();
  const priorityQueue = getPriorityQueue(state.queue, state.manicurists, state.salonServices);
  const nextSuggestedManicuristId = priorityQueue[0]?.suggestedManicurist?.id ?? null;

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <div className="w-full lg:w-[40%] border-b lg:border-b-0 lg:border-r border-gray-200 bg-gray-50/50">
        <WaitingPanel />
      </div>
      <div className="w-full lg:w-[60%]">
        <ManicuristPanel nextSuggestedManicuristId={nextSuggestedManicuristId} />
      </div>
    </div>
  );
}
