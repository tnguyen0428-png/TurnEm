import { useCallback, useEffect, useRef, useState } from 'react';
import WaitingPanel from './WaitingPanel';
import ManicuristPanel from './ManicuristPanel';

const SPLIT_KEY = 'turnem_queue_split_pct';
const MIN_PCT = 15;
const MAX_PCT = 70;
const DEFAULT_PCT = 33.333;
const LG_BREAKPOINT = 1024; // matches Tailwind's `lg` — layout flips row/column here

function loadSplit() {
  const raw = localStorage.getItem(SPLIT_KEY);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? Math.min(MAX_PCT, Math.max(MIN_PCT, parsed)) : DEFAULT_PCT;
}

// Each panel must scroll independently. The wrapper divs need a constrained
// height (via `flex-1 min-h-0`) so the inner `flex-1 overflow-y-auto` inside
// each panel actually has a finite container to scroll within. Without
// `min-h-0` flex items refuse to shrink below their content size and the
// whole page scrolls instead of each panel.
export default function QueueScreen() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [splitPct, setSplitPct] = useState(loadSplit);
  const [dragging, setDragging] = useState(false);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  useEffect(() => {
    if (!dragging) return;

    function handlePointerMove(e: PointerEvent) {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const isRow = window.innerWidth >= LG_BREAKPOINT;
      const pct = isRow
        ? ((e.clientX - rect.left) / rect.width) * 100
        : ((e.clientY - rect.top) / rect.height) * 100;
      setSplitPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)));
    }

    function handlePointerUp() {
      setDragging(false);
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [dragging]);

  useEffect(() => {
    localStorage.setItem(SPLIT_KEY, String(splitPct));
  }, [splitPct]);

  return (
    <div
      ref={containerRef}
      className={`flex flex-col lg:flex-row h-full overflow-hidden ${dragging ? 'select-none' : ''}`}
    >
      <div
        className="min-h-0 lg:h-full border-b lg:border-b-0 lg:border-r border-gray-200 bg-gray-50/50"
        style={{ flexBasis: `${splitPct}%`, flexGrow: 0, flexShrink: 0 }}
      >
        <WaitingPanel />
      </div>
      <div
        onPointerDown={handlePointerDown}
        className="shrink-0 h-1.5 lg:h-auto lg:w-1.5 cursor-row-resize lg:cursor-col-resize bg-gray-200 hover:bg-blue-400 active:bg-blue-500 transition-colors touch-none"
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
      />
      <div className="flex-1 min-h-0 lg:h-full">
        <ManicuristPanel />
      </div>
    </div>
  );
}
