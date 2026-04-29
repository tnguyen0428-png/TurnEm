// MoneyCountTable — denomination breakdown for opening/closing the drawer.
//
// Layout (mirrors SalonBiz Reconcile Cash):
//   Bills column: $100 / $50 / $20 / $10 / $5 / $1
//   Coins column: $0.25 / $0.10 / $0.05 / $0.01
//   Each row: denomination | qty input | computed amount
//   Footer:   total
//
// State is held by the parent so this can be used in OpenShiftModal and
// CloseShiftScreen interchangeably. We store the count as a Record<string,
// number> keyed by cents-per-unit ("10000", "2000", ..., "1") so it persists
// directly to the JSONB column.

import { formatMoneyCents } from '../../lib/tickets';

// Denomination set. Edit here to add $2 bills, drop pennies, etc.
export const BILL_DENOMINATIONS_CENTS = [10000, 5000, 2000, 1000, 500, 100];
export const COIN_DENOMINATIONS_CENTS = [25, 10, 5, 1];

export type DenominationCount = Record<string, number>;

/** Total cents from a denomination count. */
export function totalFromCount(count: DenominationCount): number {
  let total = 0;
  for (const [key, qty] of Object.entries(count)) {
    const cents = parseInt(key, 10);
    if (Number.isFinite(cents) && Number.isFinite(qty)) total += cents * qty;
  }
  return total;
}

/** Format the denomination key as a display label. */
function labelFor(cents: number): string {
  if (cents >= 100) return `$${cents / 100}`;
  return `${cents}¢`;
}

interface Props {
  value: DenominationCount;
  onChange: (next: DenominationCount) => void;
  disabled?: boolean;
}

export default function MoneyCountTable({ value, onChange, disabled }: Props) {
  function setQty(key: string, qty: number) {
    const safe = Number.isFinite(qty) && qty >= 0 ? Math.floor(qty) : 0;
    onChange({ ...value, [key]: safe });
  }

  const total = totalFromCount(value);

  return (
    <div className="border border-gray-100 rounded-xl overflow-hidden">
      <div className="grid grid-cols-2 gap-0">
        <Column
          title="BILLS"
          denominations={BILL_DENOMINATIONS_CENTS}
          value={value}
          onSetQty={setQty}
          disabled={disabled}
        />
        <Column
          title="COINS"
          denominations={COIN_DENOMINATIONS_CENTS}
          value={value}
          onSetQty={setQty}
          disabled={disabled}
        />
      </div>
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-t border-gray-100">
        <span className="font-bebas text-base tracking-widest text-gray-700">TOTAL</span>
        <span className="font-mono text-lg font-bold text-gray-900">
          {formatMoneyCents(total)}
        </span>
      </div>
    </div>
  );
}

function Column({
  title,
  denominations,
  value,
  onSetQty,
  disabled,
}: {
  title: string;
  denominations: number[];
  value: DenominationCount;
  onSetQty: (key: string, qty: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="border-r last:border-r-0 border-gray-100">
      <div className="px-3 py-2 bg-gray-50 border-b border-gray-100">
        <span className="font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
          {title}
        </span>
      </div>
      <div>
        {denominations.map((cents) => {
          const key = String(cents);
          const qty = value[key] ?? 0;
          const subtotalCents = cents * qty;
          return (
            <div
              key={key}
              className="grid grid-cols-[60px_1fr_90px] gap-2 items-center px-3 py-2 border-b border-gray-50 last:border-b-0"
            >
              <span className="font-mono text-sm font-semibold text-gray-700">
                {labelFor(cents)}
              </span>
              <input
                type="number"
                min={0}
                step={1}
                value={qty === 0 ? '' : qty}
                onChange={(e) => onSetQty(key, parseInt(e.target.value || '0', 10))}
                disabled={disabled}
                placeholder="0"
                className="px-2 py-1.5 rounded-md border border-gray-200 font-mono text-sm text-right focus:outline-none focus:border-gray-400 disabled:bg-gray-50"
              />
              <span
                className={`font-mono text-sm text-right ${
                  subtotalCents > 0 ? 'text-gray-900' : 'text-gray-300'
                }`}
              >
                {formatMoneyCents(subtotalCents)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
