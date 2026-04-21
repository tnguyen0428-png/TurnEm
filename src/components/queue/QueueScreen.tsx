import WaitingPanel from './WaitingPanel';
import ManicuristPanel from './ManicuristPanel';

export default function QueueScreen() {
  return (
    <div className="flex flex-col lg:flex-row h-full">
      <div className="w-full lg:w-[40%] border-b lg:border-b-0 lg:border-r border-gray-200 bg-gray-50/50">
        <WaitingPanel />
      </div>
      <div className="w-full lg:w-[60%]">
        <ManicuristPanel />
      </div>
    </div>
  );
}
