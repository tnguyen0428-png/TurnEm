import { StickyNote } from 'lucide-react';

// Attention-grabbing popup for a customer's saved permanent note. Used
// anywhere a customer profile gets matched during intake (appointment
// booking, queue check-in) so staff see the note before finishing the
// booking/check-in instead of it silently pre-filling a notes textarea
// further down the form where it's easy to miss.
export default function CustomerNoteAlert({
  name,
  note,
  onDismiss,
}: {
  name: string;
  note: string;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onDismiss}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 animate-modal-in border-2 border-amber-300"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-3">
          <StickyNote size={18} className="text-amber-500 flex-shrink-0" />
          <p className="font-mono text-[11px] font-bold tracking-wider text-amber-700 uppercase">
            Note on file — {name}
          </p>
        </div>
        <p className="text-gray-800 font-mono text-sm leading-relaxed mb-6 whitespace-pre-wrap">
          {note}
        </p>
        <div className="flex justify-end">
          <button
            onClick={onDismiss}
            className="px-4 py-2 rounded-lg text-sm font-mono font-semibold text-white bg-amber-500 hover:bg-amber-600 transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
