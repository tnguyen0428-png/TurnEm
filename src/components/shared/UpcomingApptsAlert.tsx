import { CalendarClock, Pencil, X } from 'lucide-react';
import { appointmentStaffLabel } from '../../lib/customers';
import type { Appointment } from '../../types';

// Attention-grabbing popup listing a customer's already-booked upcoming
// appointments, fired at the moment the receptionist matches that customer
// while starting a NEW booking.
//
// Why a popup and not just the panel: the MatchedCustomerBanner inside the
// appointment form already lists these rows, but it sits above the fold of a
// long form and gets scrolled past — the receptionist books a second appt for
// someone who really wanted the existing one MOVED, and the salon ends up
// double-booked. Same reasoning as CustomerNoteAlert: surface it where it
// can't be missed, at the moment it matters.
//
// Ways out:
//   • EDIT on a row  — abandon the new booking, open that existing appt.
//   • NEW APPOINTMENT — acknowledge the existing ones, keep booking a fresh one.
//   • X (top right)   — same outcome as NEW APPOINTMENT: dismiss and stay on
//                       the booking form. Kept as a deliberate button press
//                       rather than a click-away backdrop, so the popup can't
//                       be dismissed by a stray tap while the receptionist is
//                       still reading it.
// Pastel sky accent, picked over rose / lavender / peach (Tony 2026-08-28) —
// the salon's palette is pastel throughout and the original blue-500 was too
// saturated against it.
//
// Every class is written out in full rather than composed at runtime: Tailwind
// scans source text, so a concatenated class name would be purged out of the
// production build and the colour would silently vanish.
//
// Kept deliberately distinct from the other alert surfaces, which have already
// claimed their colours — emerald is the matched-profile panel, amber is the
// note alert, and pink-500 is the primary action everywhere.
const C = {
  border: 'border-sky-200', icon: 'text-sky-400', heading: 'text-sky-700',
  tableBorder: 'border-sky-100', headRow: 'bg-sky-50/70 border-sky-100',
  headText: 'text-sky-700', rowBorder: 'border-sky-50',
  editBtn: 'text-sky-700 bg-sky-50 border-sky-200 hover:bg-sky-100 hover:text-sky-900',
  cta: 'bg-sky-300 hover:bg-sky-400',
} as const;

export default function UpcomingApptsAlert({
  name,
  appointments,
  manicuristNameById,
  onEdit,
  onNew,
}: {
  name: string;
  appointments: Appointment[];
  manicuristNameById: Map<string, string>;
  onEdit: (appointmentId: string) => void;
  onNew: () => void;
}) {
  const c = C;
  function formatDate(iso: string): string {
    // Noon anchor so a date-only string never lands on the previous day in a
    // negative-offset timezone.
    const d = new Date(iso + 'T12:00:00');
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
    }).format(d);
  }
  function formatTime(t: string): string {
    const [hh, mm] = (t || '').split(':').map((s) => parseInt(s, 10));
    if (!Number.isFinite(hh)) return t;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    const h12 = ((hh + 11) % 12) + 1;
    return `${h12}:${String(mm ?? 0).padStart(2, '0')} ${ampm}`;
  }

  const count = appointments.length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className={`bg-white rounded-2xl shadow-2xl w-full max-w-3xl p-6 animate-modal-in border-2 ${c.border}`}>
        <div className="flex items-start justify-between gap-3 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <CalendarClock size={22} className={`${c.icon} flex-shrink-0`} />
            <p className={`font-mono text-sm font-bold tracking-wider ${c.heading} uppercase truncate`}>
              Already booked — {name}
            </p>
          </div>
          <button
            type="button"
            onClick={onNew}
            title="Close"
            aria-label="Close"
            className="flex items-center justify-center w-8 h-8 -mt-1 -mr-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors flex-shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <p className="font-mono text-xs text-gray-500 mb-4 ml-7">
          {count} upcoming appointment{count === 1 ? '' : 's'} on file. Edit one, or book a new one.
        </p>

        <div className={`rounded-xl border ${c.tableBorder} overflow-hidden mb-6`}>
          <div className={`grid grid-cols-[125px_85px_1.3fr_1fr_84px] gap-2 px-3 py-2 ${c.headRow} border-b font-mono text-[11px] tracking-wider font-semibold ${c.headText} uppercase`}>
            <span>Date</span>
            <span>Time</span>
            <span>Services</span>
            <span>Staff</span>
            <span aria-hidden="true" />
          </div>
          <div className="max-h-[45vh] overflow-y-auto">
            {appointments.map((a) => {
              const services = (a.services?.length ? a.services : [a.service]).join(', ');
              // Every tech on the booking, not just the first — see
              // appointmentStaffLabel for why.
              const staff = appointmentStaffLabel(a, manicuristNameById);
              return (
                <div
                  key={a.id}
                  className={`grid grid-cols-[125px_85px_1.3fr_1fr_84px] gap-2 px-3 py-2.5 border-b ${c.rowBorder} last:border-b-0 items-center`}
                >
                  <span className="font-mono text-sm font-semibold text-gray-900">{formatDate(a.date)}</span>
                  <span className="font-mono text-sm text-gray-800">{formatTime(a.time)}</span>
                  <span className="font-mono text-sm text-gray-700 truncate" title={services}>
                    {services || '—'}
                  </span>
                  <span className="font-mono text-sm text-gray-700 truncate" title={staff}>
                    {staff}
                  </span>
                  <button
                    type="button"
                    onClick={() => onEdit(a.id)}
                    className={`flex items-center justify-center gap-1 px-2.5 py-1.5 rounded-lg font-mono text-xs font-bold tracking-wider uppercase border ${c.editBtn} transition-colors`}
                  >
                    <Pencil size={12} />
                    Edit
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={onNew}
            className={`px-5 py-2.5 rounded-lg text-base font-mono font-semibold tracking-wider uppercase text-white ${c.cta} transition-colors`}
          >
            New appointment
          </button>
        </div>
      </div>
    </div>
  );
}
