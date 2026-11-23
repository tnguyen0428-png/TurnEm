// GiftCertLookupModal — register top bar → gift icon.
//
// Lets a receptionist look up ONE gift certificate's history at a time:
// type the number, see how it was loaded, every use and the balance. Unlike
// Blueprint → Gift Certificates there is no list, no browsing and no "close
// numbers" suggestions, so the desk only ever sees the card it typed
// (Tony, 2026-11-23).

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import Modal from '../shared/Modal';
import CertHistoryPanel from '../shared/GiftCertHistoryPanel';
import {
  fetchGiftCertHistory,
  normalizeSerial,
  type GiftCertHistory,
} from '../../lib/giftCertificates';

export default function GiftCertLookupModal({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState('');
  const [serial, setSerial] = useState('');
  const [history, setHistory] = useState<GiftCertHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function lookUp() {
    const norm = normalizeSerial(input.replace(/\s+/g, ''));
    if (!norm) return;
    setSerial(norm);
    setHistory(null);
    setLoading(true);
    const h = await fetchGiftCertHistory(norm);
    setHistory(h);
    setLoading(false);
  }

  return (
    <Modal title="GIFT CERTIFICATE LOOKUP" onClose={onClose} width="max-w-4xl">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void lookUp();
        }}
        className="flex items-center gap-2 mb-4"
      >
        <label className="flex-1 flex items-center gap-3 bg-white border border-gray-300 rounded-lg px-4 h-14 focus-within:border-gray-500">
          <Search size={20} className="text-gray-400" />
          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Gift certificate #"
            className="flex-1 font-mono text-xl bg-transparent focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!normalizeSerial(input) || loading}
          className="h-14 px-6 rounded-lg bg-gray-900 text-white hover:bg-gray-800 font-mono text-base font-bold tracking-wider disabled:opacity-40"
        >
          LOOK UP
        </button>
      </form>

      {serial ? (
        <CertHistoryPanel
          serial={serial}
          history={history}
          loading={loading}
          nearMisses={[]}
          onPick={() => {}}
          size="medium"
        />
      ) : (
        <p className="font-mono text-base text-gray-400">
          Enter one certificate number to see when it was sold, every time it was used, and what's left.
        </p>
      )}
    </Modal>
  );
}
