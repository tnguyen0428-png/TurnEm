import { useEffect, useRef, useState, type ReactNode } from 'react';
import { X, GripHorizontal } from 'lucide-react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: string;
  /**
   * 'center' (default): classic full-screen modal with a darkening backdrop.
   * 'right': dock the panel to the right edge of the viewport with NO
   *          backdrop, so the underlying screen stays fully visible/clickable
   *          (used by the appointment-book NEW APPT panel so the receptionist
   *          can still see the schedule while booking).
   */
  dock?: 'center' | 'right';
}

export default function Modal({ title, onClose, children, width = 'max-w-lg', dock = 'center' }: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  if (dock === 'right') {
    return <RightDockedPanel title={title} width={width} onClose={onClose}>{children}</RightDockedPanel>;
  }

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={(e) => e.target === overlayRef.current && onClose()}
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${width} max-h-[90vh] flex flex-col animate-modal-in`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-bebas text-2xl tracking-widest text-gray-900">{title}</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
          >
            <X size={20} />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// Draggable right-docked panel.
// Starts anchored to the top-right with no backdrop. The receptionist can
// drag the panel anywhere on screen by mousing down on the header bar (the
// grip area / title) and dragging — useful when the panel is covering an
// appointment they want to see while booking.
function RightDockedPanel({
  title,
  width,
  onClose,
  children,
}: { title: string; width: string; onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Position offset from initial top-right anchor. null = use default (CSS
  // anchored top-right). Once the user drags, we switch to absolute left/top.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origLeft: number; origTop: number } | null>(null);

  function onHeaderMouseDown(e: React.MouseEvent) {
    // Skip if the user clicked the close button itself
    const target = e.target as HTMLElement;
    if (target.closest('[data-modal-close]')) return;
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origLeft: rect.left,
      origTop: rect.top,
    };
    e.preventDefault();
  }

  useEffect(() => {
    function onMove(ev: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      // Clamp so the panel stays at least partially on screen.
      const el = panelRef.current;
      const w = el?.offsetWidth ?? 400;
      const h = el?.offsetHeight ?? 200;
      const maxLeft = window.innerWidth - 60;   // leave 60px visible on the left side
      const maxTop = window.innerHeight - 40;   // leave 40px visible at top
      const minLeft = -(w - 120);               // at least 120px of panel stays visible to drag back
      const minTop = 0;
      let nextLeft = d.origLeft + dx;
      let nextTop = d.origTop + dy;
      if (nextLeft > maxLeft) nextLeft = maxLeft;
      if (nextLeft < minLeft) nextLeft = minLeft;
      if (nextTop > maxTop) nextTop = maxTop;
      if (nextTop < minTop) nextTop = minTop;
      // Suppress unused-var warning if h is not used
      void h;
      setPos({ left: nextLeft, top: nextTop });
    }
    function onUp() {
      dragRef.current = null;
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Outer wrapper: when not yet dragged, anchor top-right via flex. Once
  // dragged, the panel is positioned absolutely at (left, top) within a
  // full-viewport container.
  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
    >
      <div
        ref={panelRef}
        className={`absolute bg-white shadow-2xl border border-gray-200 rounded-2xl w-screen ${width} max-h-screen flex flex-col animate-modal-in pointer-events-auto`}
        style={pos ? { left: pos.left, top: pos.top, right: 'auto' } : { right: 0, top: 0 }}
      >
        <div
          onMouseDown={onHeaderMouseDown}
          className="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0 cursor-move select-none"
          title="Drag to move"
        >
          <div className="flex items-center gap-2">
            <GripHorizontal size={16} className="text-gray-300" />
            <h2 className="font-bebas text-2xl tracking-widest text-gray-900">{title}</h2>
          </div>
          <button
            data-modal-close
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
          >
            <X size={20} />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
