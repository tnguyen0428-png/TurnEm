interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  danger?: boolean;
  // Optional THIRD choice, for the cases where "go back" and "confirm" aren't
  // the only two outcomes — e.g. cancelling a split child, where the card can
  // either return to the queue or be discarded outright. Rendered as an
  // outlined button so it reads as a deliberate alternative, not the default.
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Bigger panel, message and buttons, for a decision made standing at a
   *  tablet on the floor rather than sitting at the desk. Opt-in so the
   *  dialogs everywhere else keep their current size. */
  large?: boolean;
}

export default function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  confirmLabel = 'Confirm',
  danger = false,
  secondaryLabel,
  onSecondary,
  large = false,
}: ConfirmDialogProps) {
  const panelWidth = large ? 'max-w-lg' : 'max-w-sm';
  const panelPad = large ? 'p-7' : 'p-6';
  const messageText = large ? 'text-lg' : 'text-sm';
  const btnText = large ? 'text-base px-5 py-3' : 'text-sm px-4 py-2';
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onCancel}
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${panelWidth} ${panelPad} animate-modal-in`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className={`text-gray-800 font-mono ${messageText} leading-relaxed mb-6 whitespace-pre-line`}>{message}</p>
        {secondaryLabel && onSecondary && (
          <button
            onClick={onSecondary}
            className={`w-full mb-3 ${btnText} rounded-lg font-mono font-semibold text-red-600 border-2 border-red-200 hover:bg-red-50 active:scale-[0.98] transition-all`}
          >
            {secondaryLabel}
          </button>
        )}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className={`${btnText} rounded-lg font-mono font-medium text-gray-600 hover:bg-gray-100 transition-colors`}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`${btnText} rounded-lg font-mono font-semibold text-white transition-colors ${
              danger ? 'bg-red-500 hover:bg-red-600' : 'bg-pink-500 hover:bg-pink-600'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
