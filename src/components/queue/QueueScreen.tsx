import { useState, useRef, useEffect } from 'react';
import WaitingPanel from './WaitingPanel';
import ManicuristPanel from './ManicuristPanel';

export default function QueueScreen() {
  const [leftPct, setLeftPct] = useState(40);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(75, Math.max(20, pct)));
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  function startDrag(e: React.MouseEvent) {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  const leftStyle = { '--left-pct': `${leftPct}%` } as React.CSSProperties;

  return (
    <div ref={containerRef} className="flex flex-col lg:flex-row h-full">
      <div
        className="w-full lg:w-[var(--left-pct)] border-b lg:border-b-0 border-gray-200 bg-gray-50/50"
        style={leftStyle}
      >
        <WaitingPanel />
      </div>
      <div
        onMouseDown={startDrag}
        className="hidden lg:block w-1 cursor-col-resize bg-gray-200 hover:bg-pink-400 active:bg-pink-500 transition-colors flex-shrink-0"
        title="Drag to resize"
      />
      <div className="w-full lg:flex-1">
        <ManicuristPanel />
      </div>
    </div>
  );
}
