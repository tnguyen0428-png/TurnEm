import WaitingPanel from './WaitingPanel';
import ManicuristPanel from './ManicuristPanel';

// Each panel must scroll independently. The wrapper divs need a constrained
// height (via `flex-1 min-h-0`) so the inner `flex-1 overflow-y-auto` inside
// each panel actually has a finite container to scroll within. Without
// `min-h-0` flex items refuse to shrink below their content size and the
// whole page scrolls instead of each panel.
export default function QueueScreen() {
  return (
    <div className="flex flex-col lg:flex-row h-full overflow-hidden">
      <div className="flex-1 min-h-0 lg:flex-none lg:w-1/3 lg:h-full border-b lg:border-b-0 lg:border-r border-gray-200 bg-gray-50/50">
        <WaitingPanel />
      </div>
      <div className="flex-[2] min-h-0 lg:flex-none lg:w-2/3 lg:h-full">
        <ManicuristPanel />
      </div>
    </div>
  );
}
