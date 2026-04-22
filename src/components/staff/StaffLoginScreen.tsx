import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Manicurist } from '../../types';

interface StaffLoginScreenProps {
  manicurists: Manicurist[];
  onLogin: (manicurist: Manicurist) => void;
}

export default function StaffLoginScreen({ manicurists, onLogin }: StaffLoginScreenProps) {
  const [selectedId, setSelectedId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const clockedIn = manicurists.filter((m) => m.clockedIn);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!selectedId) {
      setError('Please select your name');
      return;
    }
    if (!pin) {
      setError('Please enter your PIN');
      return;
    }

    setLoading(true);

    const manicurist = manicurists.find((m) => m.id === selectedId);
    if (!manicurist) {
      setError('Staff member not found');
      setLoading(false);
      return;
    }

    if (!manicurist.pinCode) {
      setError('No PIN set — ask your manager to set one up');
      setLoading(false);
      return;
    }

    if (manicurist.pinCode !== pin) {
      setError('Incorrect PIN');
      setPin('');
      setLoading(false);
      return;
    }

    onLogin(manicurist);
    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <img
            src="/Turn_Em_Logo.jpg"
            alt="TurnEM Logo"
            className="w-96 h-auto object-contain"
          />
        </div>

        <div className="text-center mb-6">
          <span className="inline-block px-3 py-1 rounded-full bg-indigo-50 text-indigo-600 font-mono text-[10px] font-bold tracking-wider uppercase">
            STAFF PORTAL
          </span>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-100">
            <p className="font-mono text-xs text-red-600">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              YOUR NAME
            </label>
            <select
              value={selectedId}
              onChange={(e) => { setSelectedId(e.target.value); setError(null); }}
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all bg-white"
            >
              <option value="">Select your name...</option>
              {clockedIn.length > 0 && (
                <optgroup label="Clocked In">
                  {clockedIn.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </optgroup>
              )}
              {manicurists.filter((m) => !m.clockedIn).length > 0 && (
                <optgroup label="Not Clocked In">
                  {manicurists.filter((m) => !m.clockedIn).map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          </div>

          <div>
            <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider mb-1.5">
              PIN
            </label>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setError(null); }}
              placeholder="Enter PIN..."
              className="w-full px-4 py-3 rounded-xl border border-gray-200 font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-pink-200 focus:border-pink-300 transition-all text-center tracking-[8px]"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !selectedId || !pin}
            className="w-full py-3 rounded-xl bg-indigo-500 text-white font-mono text-sm font-semibold hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all flex items-center justify-center gap-2"
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            SIGN IN
          </button>
        </form>
      </div>
    </div>
  );
}
