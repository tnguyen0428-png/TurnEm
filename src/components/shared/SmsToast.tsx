import { useState, useEffect, useCallback } from 'react';
import { MessageSquare } from 'lucide-react';

type SmsStatus = 'idle' | 'sending' | 'sent' | 'failed' | 'no-phone';

let globalSetStatus: ((status: SmsStatus) => void) | null = null;

export function showSmsToast(status: SmsStatus) {
  globalSetStatus?.(status);
}

export default function SmsToast() {
  const [status, setStatus] = useState<SmsStatus>('idle');

  const handleStatus = useCallback((s: SmsStatus) => {
    setStatus(s);
    if (s !== 'sending') {
      setTimeout(() => setStatus('idle'), 3500);
    }
  }, []);

  useEffect(() => {
    globalSetStatus = handleStatus;
    return () => { globalSetStatus = null; };
  }, [handleStatus]);

  if (status === 'idle') return null;

  return (
    <div className="fixed bottom-6 right-6 z-[200]">
      <div
        className={`flex items-center gap-2.5 px-5 py-3.5 rounded-xl shadow-lg font-mono text-xs font-semibold transition-all duration-300 ${
          status === 'sending' ? 'bg-blue-50 text-blue-700 border border-blue-200' :
          status === 'sent' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' :
          status === 'failed' ? 'bg-red-50 text-red-700 border border-red-200' :
          'bg-amber-50 text-amber-700 border border-amber-200'
        }`}
        style={{ animation: 'slideUp 0.3s ease-out' }}
      >
        <MessageSquare size={14} />
        {status === 'sending' && 'Sending SMS alert...'}
        {status === 'sent' && 'SMS alert sent!'}
        {status === 'failed' && 'SMS alert failed to send'}
        {status === 'no-phone' && 'No phone on file - SMS skipped'}
      </div>
    </div>
  );
}
