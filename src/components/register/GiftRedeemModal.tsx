import { useEffect, useRef, useState } from 'react';
import { Gift, X, AlertTriangle, Check } from 'lucide-react';
import { lookupGiftCardDetail, normalizeSerial, type GiftCardDetail } from '../../lib/giftCertificates';
import { formatMoneyCents, parseDollarsToCents } from '../../lib/tickets';

interface Props {
  ticketId: string;
  /** Remaining balance owed on the ticket — used to pre-fill the amount. */
  dueCents: number;
  /** Called with the cert serial + amount (cents) when the cashier saves. */
  onApply: (giftCardCode: string, amountCents: number) => void;
  onClose: () => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(s: string | null): string {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export default function GiftRedeemModal({ ticketId, dueCents, onApply, onClose }: Props) {
  const [serial, setSerial] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [detail, setDetail] = useState<GiftCardDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const serialRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const touchedRef = useRef(false);
  const reqRef = useRef(0);

  useEffect(() => { serialRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Debounced lookup whenever the serial changes.
  useEffect(() => {
    const norm = normalizeSerial(serial);
    if (!norm) { setDetail(null); setLoading(false); return; }
    setLoading(true);
    const id = ++reqRef.current;
    const t = setTimeout(async () => {
      try {
        const d = await lookupGiftCardDetail(serial, ticketId);
        if (reqRef.current !== id) return;
        setDetail(d);
        setLoading(false);
        if (d.found && !d.lookupError && !touchedRef.current) {
          const def = Math.min(d.balanceCents, Math.max(0, dueCents));
          setAmountInput((def / 100).toFixed(2));
        }
      } catch {
        if (reqRef.current !== id) return;
        setDetail({ found: false, lookupError: true, originalCents: 0, purchaseDate: null, purchaseClientName: null, usedCents: 0, balanceCents: 0, redemptions: [] });
        setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  // dueCents intentionally omitted: captured at the time the serial changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, ticketId]);

  const found = !!detail?.found && !detail?.lookupError;
  const balanceCents = found ? detail!.balanceCents : 0;
  const amountCents = parseDollarsToCents(amountInput);
  const leftoverCents = Math.max(0, balanceCents - amountCents);
  const overBalance = found && amountCents > balanceCents;
  const overDue = found && amountCents > Math.max(0, dueCents);
  const canSave = found && amountCents > 0 && !overBalance;

  function handleSerialChange(v: string) {
    touchedRef.current = false;
    setSerial(v);
  }
  function handleSave() {
    if (!canSave) return;
    onApply(serial.trim(), Math.min(amountCents, balanceCents));
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md animate-modal-in" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 flex items-center justify-between">
          <span className="flex items-center gap-2 font-mono text-base font-bold text-gray-900">
            <Gift size={18} className="text-pink-500" /> Redeem gift certificate
          </span>
          <button onClick={onClose} className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pb-5 flex flex-col gap-3">
          <p className="font-mono text-xs text-gray-500 -mt-1">
            Ticket balance due <span className="font-bold text-gray-800">{formatMoneyCents(Math.max(0, dueCents))}</span>
          </p>

          <div>
            <label className="block font-mono text-xs text-gray-500 mb-1">Gift certificate #</label>
            <input
              ref={serialRef}
              value={serial}
              onChange={(e) => handleSerialChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); amountRef.current?.focus(); amountRef.current?.select(); } }}
              placeholder="Scan or type the cert number"
              className="w-full px-2.5 py-2 rounded-lg border border-gray-300 font-mono text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:border-pink-400"
            />
          </div>

          {loading && (
            <p className="font-mono text-xs text-gray-400">Looking up…</p>
          )}

          {!loading && detail && detail.lookupError && (
            <div className="px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 font-mono text-xs text-amber-800 flex items-center gap-2">
              <AlertTriangle size={14} /> Couldn’t verify this cert — check the connection and try again.
            </div>
          )}

          {!loading && detail && !detail.found && !detail.lookupError && normalizeSerial(serial) && (
            <div className="px-3 py-2.5 rounded-lg bg-red-50 border border-red-200 font-mono text-xs text-red-700 flex items-center gap-2">
              <AlertTriangle size={14} /> Not in the system — only gift certs sold here can be redeemed.
            </div>
          )}

          {found && (
            <div className="rounded-lg border border-gray-200 p-3 flex flex-col gap-1.5">
              <div className="flex justify-between font-mono text-xs">
                <span className="text-gray-500">Original value</span>
                <span className="font-bold text-gray-800">{formatMoneyCents(detail!.originalCents)}</span>
              </div>
              <div className="flex justify-between font-mono text-xs">
                <span className="text-gray-500">Purchased</span>
                <span className="text-gray-800">{fmtDate(detail!.purchaseDate)}{detail!.purchaseClientName ? ` · ${detail!.purchaseClientName}` : ''}</span>
              </div>
              <div className="border-t border-gray-100 my-1" />
              <span className="font-mono text-[11px] text-gray-500">Previously used</span>
              {detail!.redemptions.length === 0 ? (
                <span className="font-mono text-xs text-gray-400">No prior redemptions</span>
              ) : (
                detail!.redemptions.map((r, i) => (
                  <div key={i} className="flex justify-between font-mono text-xs text-gray-500">
                    <span>{fmtDate(r.date)}{r.ticketNumber ? ` · ticket #${r.ticketNumber}` : ''}</span>
                    <span>−{formatMoneyCents(r.amountCents)}</span>
                  </div>
                ))
              )}
              <div className="border-t border-gray-100 my-1" />
              <div className="flex justify-between items-center">
                <span className="font-mono text-xs text-gray-500">Balance available</span>
                <span className="font-mono text-xl font-bold text-emerald-600">{formatMoneyCents(balanceCents)}</span>
              </div>
            </div>
          )}

          {found && (
            <div>
              <label className="block font-mono text-xs text-gray-500 mb-1">Amount to use</label>
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-sm text-gray-600">$</span>
                <input
                  ref={amountRef}
                  type="text"
                  inputMode="decimal"
                  value={amountInput}
                  onChange={(e) => { touchedRef.current = true; setAmountInput(e.target.value); }}
                  onBlur={(e) => setAmountInput((parseDollarsToCents(e.target.value) / 100).toFixed(2))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSave(); } }}
                  className="flex-1 px-2 py-2 rounded-lg border border-gray-300 font-mono text-base text-right text-gray-900 focus:outline-none focus:border-pink-400"
                />
              </div>
              <div className="flex justify-between items-baseline mt-2">
                <span className="font-mono text-xs text-gray-500">Left on cert after this</span>
                <span className="font-mono text-lg font-bold text-red-600">{formatMoneyCents(leftoverCents)}</span>
              </div>
              {overBalance && (
                <p className="font-mono text-xs text-red-600 mt-1 flex items-center gap-1">
                  <AlertTriangle size={12} /> Only {formatMoneyCents(balanceCents)} available on this cert.
                </p>
              )}
              {!overBalance && overDue && (
                <p className="font-mono text-xs text-amber-600 mt-1">That’s more than the {formatMoneyCents(Math.max(0, dueCents))} due on the ticket.</p>
              )}
            </div>
          )}

          <div className="flex gap-2 mt-1">
            <button onClick={onClose}
              className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 text-gray-800 hover:bg-gray-50 font-mono text-sm font-semibold">
              Cancel
            </button>
            <button onClick={handleSave} disabled={!canSave}
              className="flex-[2] px-4 py-2.5 rounded-lg bg-pink-500 text-white hover:bg-pink-600 font-mono text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-1.5">
              <Check size={15} /> Save &amp; apply to ticket
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
