import { StickyNote } from 'lucide-react';

// Attention-grabbing popup for the notes attached to a client. Used anywhere
// a customer gets matched during intake (appointment booking, queue check-in,
// assignment) so staff see the note at the moment it matters instead of it
// silently pre-filling a notes textarea further down the form where it's easy
// to miss.
//
// Two independent notes can apply to the same visit and they mean different
// things, so both are surfaced together rather than one winning:
//   • `note`     — the customer's PERMANENT note, saved on their profile and
//                  true on every visit ("allergic to acetone").
//   • `apptNote` — the note typed on THIS booking, true only today ("wants
//                  short round, coming from work").
// Either may be empty; the caller is expected not to render this at all when
// both are. Labels only appear when both are present — a single note keeps
// the original uncluttered layout.
export default function CustomerNoteAlert({
  name,
  note,
  apptNote,
  onDismiss,
}: {
  name: string;
  note?: string | null;
  apptNote?: string | null;
  onDismiss: () => void;
}) {
  const permanent = (note ?? '').trim();
  const appointment = (apptNote ?? '').trim();
  const showLabels = permanent.length > 0 && appointment.length > 0;
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
        <div className="mb-6 space-y-4">
          {permanent.length > 0 && (
            <div>
              {showLabels && (
                <p className="font-mono text-[10px] font-bold tracking-wider text-amber-600 uppercase mb-1">
                  Permanent note
                </p>
              )}
              <p className="text-gray-800 font-mono text-sm leading-relaxed whitespace-pre-wrap">
                {permanent}
              </p>
            </div>
          )}
          {appointment.length > 0 && (
            <div>
              {showLabels && (
                <p className="font-mono text-[10px] font-bold tracking-wider text-amber-600 uppercase mb-1">
                  This appointment
                </p>
              )}
              <p className="text-gray-800 font-mono text-sm leading-relaxed whitespace-pre-wrap">
                {appointment}
              </p>
            </div>
          )}
        </div>
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
