// BreakElapsedBadge — the "ON BREAK 5:23" pill displayed on a manicurist
// card while they're on a break.
//
// This component is intentionally isolated so the shared 1Hz clock only
// re-renders this small subtree once per second. ManicuristCard itself
// stays still between actual prop changes, instead of re-rendering once
// per second per card.

import { memo } from 'react';
import { Clock } from 'lucide-react';
import { useElapsedTime } from '../../hooks/useElapsedTime';

interface Props {
  /** Epoch ms when the break started, or null to render nothing. */
  breakStartTime: number | null;
}

function BreakElapsedBadgeImpl({ breakStartTime }: Props) {
  const elapsed = useElapsedTime(breakStartTime);
  if (!breakStartTime || !elapsed) return null;
  return (
    <div className="bg-amber-50 rounded-lg px-2 py-1.5 mb-1.5 flex items-center gap-1.5">
      <Clock size={11} className="text-amber-500 shrink-0" />
      <span className="font-mono text-[11px] font-bold text-amber-700 tabular-nums">{elapsed}</span>
      <span className="font-mono text-[9px] text-amber-500 tracking-wider">ON BREAK</span>
    </div>
  );
}

export default memo(BreakElapsedBadgeImpl);
