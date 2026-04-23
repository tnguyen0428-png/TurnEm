interface AssignmentRow {
  manicuristName: string;
  manicuristColor: string;
  services: string[];
  turnsToAdd: number;
  isDeferred?: boolean;
  isRequested?: boolean;
}

interface AssignConfirmDialogProps {
  clientName: string;
  rows: AssignmentRow[];
  onConfirm: () => void;
  onCancel: () => void;
}

function formatServicesForBadges(services: string[]): string[] {
  const map = new Map<string, number>();
  for (const s of services) map.set(s, (map.get(s) || 0) + 1);
  return Array.from(map.entries()).map(([s, count]) => (count > 1 ? `${s} x${count}` : s));
}

export default function AssignConfirmDialog({
  clientName,
  rows,
  onConfirm,
  onCancel,
}: AssignConfirmDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="bg-pink-500 px-5 py-3.5 flex items-center gap-3">
          <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="6" stroke="white" strokeWidth="1.5" />
              <path d="M7 4v3.5l2 1.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
          <p className="font-mono text-sm font-semibold text-white uppercase tracking-wide">
            Confirm Turn Assignment
          </p>
        </div>

        {/* Body */}
        <div className="px-5 pt-4 pb-2">
          {/* Client name */}
          <div className="flex justify-between items-center py-2.5 border-b border-gray-100">
            <span className="font-mono text-[11px] uppercase tracking-widest text-gray-400">Client</span>
            <span className="font-mono text-sm font-semibold text-gray-900">{clientName}</span>
          </div>

          {/* One block per manicurist assignment */}
          {rows.map((row, i) => (
            <div key={i} className="pt-3 pb-2.5 border-b border-gray-100 last:border-0">
              {/* Services */}
              <div className="flex justify-between items-start mb-2.5">
                <span className="font-mono text-[11px] uppercase tracking-widest text-gray-400 pt-0.5 flex-shrink-0">
                  Service
                </span>
                <div className="flex flex-wrap gap-1.5 justify-end items-center ml-4">
                  {row.isRequested && (
                    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white font-mono text-[9px] font-bold flex-shrink-0">
                      R
                    </span>
                  )}
                  {formatServicesForBadges(row.services).map((label, si) => (
                    <span
                      key={si}
                      className="inline-block bg-teal-50 text-teal-700 font-mono text-[10px] font-semibold px-2.5 py-1 rounded-full uppercase tracking-wide"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>

              {/* Manicurist */}
              <div className="flex justify-between items-center mb-2.5">
                <span className="font-mono text-[11px] uppercase tracking-widest text-gray-400">
                  Manicurist
                </span>
                <div className="flex items-center gap-2">
                  <div
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: row.manicuristColor }}
                  />
                  <span className="font-mono text-sm font-semibold text-gray-900">{row.manicuristName}</span>
                  {row.isDeferred && (
                    <span className="font-mono text-[9px] font-bold text-amber-500 uppercase">
                      (waiting)
                    </span>
                  )}
                </div>
              </div>

              {/* Turns */}
              <div className="flex justify-between items-center">
                <span className="font-mono text-[11px] uppercase tracking-widest text-gray-400">
                  {row.manicuristName}'s turns
                </span>
                {row.isDeferred ? (
                  <span className="font-mono text-xs text-amber-500 font-semibold">Added when available</span>
                ) : (
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-xl font-semibold text-pink-500">
                      {row.turnsToAdd.toFixed(1)}
                    </span>
                    <span className="font-mono text-[10px] text-gray-400">turns added</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-5 py-4 border-t border-gray-100">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-gray-200 font-mono text-sm font-semibold text-gray-600 hover:bg-gray-50 active:scale-[0.98] transition-all uppercase tracking-wide"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl bg-pink-500 font-mono text-sm font-semibold text-white hover:bg-pink-600 active:scale-[0.98] transition-all uppercase tracking-wide"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
