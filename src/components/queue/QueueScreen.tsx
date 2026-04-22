import { useState, useRef, useEffect } from 'react';
import WaitingPanel from './WaitingPanel';
import ManicuristPanel from './ManicuristPanel';

export default function QueueScreen() {
  const [pct, setPct] = useState(40);
  const [isDesktop, setIsDesktop] = useState(
    typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    function applyMove(clientX: number, clientY: number) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const next = isDesktop
        ? ((clientX - rect.left) / rect.width) * 100
        : ((clientY - rect.top) / rect.height) * 100;
      setPct(Math.min(80, Math.max(15, next)));
    }
    function onMouseMove(e: MouseEvent) {
      if (!draggingRef.current) return;
      applyMove(e.clientX, e.clientY);
    }
    function onTouchMove(e: TouchEvent) {
      if (!draggingRef.current || !e.touches[0]) return;
      e.preventDefault();
      applyMove(e.touches[0].clientX, e.touches[0].clientY);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
    };
  }, [isDesktop]);

  function startDrag(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = isDesktop ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }

  const firstStyle: React.CSSProperties = isDesktop
    ? { width: `${pct}%`, height: '100%' }
    : { height: `${pct}%`, width: '100%' };

  return (
    <div ref={containerRef} className="flex flex-col lg:flex-row h-full">
      <div className="bg-gray-50/50 overflow-auto" style={firstStyle}>
        <WaitingPanel />
      </div>
      <div
        onMouseDown={startDrag}
        onTouchStart={startDrag}
        className={
          isDesktop
            ? 'w-1 cursor-col-resize bg-gray-200 hover:bg-pink-400 active:bg-pink-500 transition-colors flex-shrink-0'
            : 'h-1 cursor-row-resize bg-gray-200 hover:bg-pink-400 active:bg-pink-500 transition-colors flex-shrink-0 touch-none'
        }
        title="Drag to resize"
      />
      <div className="flex-1 min-h-0 min-w-0 overflow-auto">
        <ManicuristPanel />
      </div>
    </div>
  );
}
