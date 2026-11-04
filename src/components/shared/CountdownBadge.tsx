import { Clock } from 'lucide-react';
import { useCountdown } from '../../hooks/useCountdown';

interface CountdownBadgeProps {
  startedAt: number | null;
  totalDurationMs: number;
  status: string;
  /** 'lg' is for the assigned-client box on a tech card, read across the
   *  floor (Tony 2026-11-04). The assign modals keep the default size. */
  size?: 'md' | 'lg';
}

export default function CountdownBadge({ startedAt, totalDurationMs, status, size = 'md' }: CountdownBadgeProps) {
  const { display, isFinishingUp, isAlmostDone } = useCountdown(startedAt, totalDurationMs);
  const lg = size === 'lg';
  const alertText = lg ? 'text-[13px]' : 'text-[11px]';
  const iconSize = lg ? 13 : 10;

  if (status !== 'busy' || !startedAt) return null;

  if (isFinishingUp) {
    return (
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-mono ${alertText} font-bold bg-red-500 text-white animate-pulse tabular-nums shadow-sm`}>
        <Clock size={iconSize} />
        Finishing up
      </span>
    );
  }

  if (isAlmostDone) {
    return (
      <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-mono ${alertText} font-bold bg-orange-500 text-white tabular-nums shadow-sm`}>
        <Clock size={iconSize} />
        {display} — Almost done
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-1 rounded-full font-mono font-semibold bg-amber-100 text-amber-900 tabular-nums ${lg ? 'text-[13px] px-2.5 py-0.5' : 'text-[10px] px-2 py-0.5'}`}>
      <Clock size={lg ? 12 : 9} />
      {display}
    </span>
  );
}
