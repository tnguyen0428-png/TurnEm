// CustomersScreen — Blueprint → Customers
//
// Three states wrapped in one screen:
//   1. List   — search + create button; click a row to open detail
//   2. Detail — header, popup-note callout, history sections, edit/delete
//   3. Form   — create or edit a customer
//
// History matches by phone (digits-only) first, then by full lowercased name.
// Appointments come from the live AppContext state (already in memory);
// tickets are fetched on demand via fetchCustomerTickets.

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Edit3, Plus, Search, Trash2, AlertTriangle, RefreshCw,
  User, Phone, Mail, StickyNote, Calendar, Receipt,
} from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { supabase } from '../../lib/supabase';
import type { Appointment, Customer } from '../../types';
import {
  fetchCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  fetchCustomerTickets,
  matchAppointments,
  displayCustomerName,
  normalizePhone,
  normalizeName,
  type CustomerInput,
} from '../../lib/customers';
import { formatMoneyCents } from '../../lib/tickets';

type Mode =
  | { kind: 'list' }
  | { kind: 'detail'; customerId: string }
  | { kind: 'form'; customerId: string | null };

function formatPhone(raw: string): string {
  const digits = normalizePhone(raw);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso + 'T12:00:00');
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(d);
}

export default function CustomersScreen() {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    const rows = await fetchCustomers();
    setCustomers(rows);
    setLoading(false);
  };

  useEffect(() => { void refresh(); }, []);

  // Live updates: subscribe to any insert/update/delete on customers so
  // adding a client in the Appointments or Queue modal immediately surfaces
  // here without the user needing to navigate away and back.
  useEffect(() => {
    const channel = supabase
      .channel('blueprint-customers-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'customers' },
        () => { void refresh(); },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, []);

  function goList() { setMode({ kind: 'list' }); }
  function goDetail(id: string) { setMode({ kind: 'detail', customerId: id }); }
  function goEdit(id: string) { setMode({ kind: 'form', customerId: id }); }
  function goNew() { setMode({ kind: 'form', customerId: null }); }

  if (mode.kind === 'form') {
    return (
      <CustomerFormScreen
        customer={mode.customerId ? customers.find((c) => c.id === mode.customerId) ?? null : null}
        onCancel={() => mode.customerId ? goDetail(mode.customerId) : goList()}
        onSaved={async (id) => { await refresh(); goDetail(id); }}
      />
    );
  }
  if (mode.kind === 'detail') {
    const c = customers.find((x) => x.id === mode.customerId);
    if (!c) {
      // Customer disappeared (deleted from another tab?). Fall back to list.
      return <CustomerListView customers={customers} loading={loading} onSelect={goDetail} onNew={goNew} onRefresh={refresh} />;
    }
    return (
      <CustomerDetailView
        customer={c}
        onBack={goList}
        onEdit={() => goEdit(c.id)}
        onDeleted={async () => { await refresh(); goList(); }}
      />
    );
  }
  return (
    <CustomerListView
      customers={customers}
      loading={loading}
      onSelect={goDetail}
      onNew={goNew}
      onRefresh={refresh}
    />
  );
}

// ── List view ────────────────────────────────────────────────────────────────

function CustomerListView({
  customers, loading, onSelect, onNew, onRefresh,
}: {
  customers: Customer[];
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void | Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    const qDigits = normalizePhone(q);
    return customers.filter((c) => {
      const name = `${c.firstName} ${c.lastName}`.toLowerCase();
      if (name.includes(q)) return true;
      if (qDigits && normalizePhone(c.phone).includes(qDigits)) return true;
      if ((c.email || '').toLowerCase().includes(q)) return true;
      return false;
    });
  }, [customers, query]);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <User size={22} className="text-pink-500" />
          <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">CUSTOMERS</h2>
          <span className="font-mono text-[10px] text-gray-400">{customers.length} total</span>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2 min-w-[260px]">
            <Search size={14} className="text-gray-400" />
            <input
              type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, phone, email…"
              className="flex-1 font-mono text-xs bg-transparent focus:outline-none"
            />
          </label>
          <button
            onClick={onRefresh}
            disabled={loading}
            title="Refresh"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={onNew}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-pink-600 text-white font-mono text-xs font-bold hover:bg-pink-700"
          >
            <Plus size={14} /> NEW CUSTOMER
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center font-mono text-xs text-gray-400">
            {loading ? 'Loading…' : query ? 'No customers match the search.' : 'No customers yet. Add one to get started.'}
          </div>
        ) : (
          <div>
            <div className="grid grid-cols-[1fr_180px_1fr_60px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Name</span>
              <span>Phone</span>
              <span>Email</span>
              <span className="text-right">Note</span>
            </div>
            {filtered.map((c) => (
              <button
                type="button"
                key={c.id}
                onClick={() => onSelect(c.id)}
                className="w-full grid grid-cols-[1fr_180px_1fr_60px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center hover:bg-pink-50/40 transition-colors text-left"
              >
                <span className="font-mono text-sm font-semibold text-gray-900 truncate">
                  {displayCustomerName(c)}
                </span>
                <span className="font-mono text-xs text-gray-700">{formatPhone(c.phone)}</span>
                <span className="font-mono text-xs text-gray-500 truncate">{c.email || '—'}</span>
                <span className="text-right">
                  {c.popupNote && (
                    <AlertTriangle size={14} className="inline-block text-amber-500" />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────────────────────

function CustomerDetailView({
  customer, onBack, onEdit, onDeleted,
}: {
  customer: Customer;
  onBack: () => void;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const { state } = useApp();
  const [tickets, setTickets] = useState<Awaited<ReturnType<typeof fetchCustomerTickets>>>([]);
  const [ticketsLoading, setTicketsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setTicketsLoading(true);
      const rows = await fetchCustomerTickets(customer);
      if (!cancelled) {
        setTickets(rows);
        setTicketsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [customer]);

  const appts = useMemo<Appointment[]>(
    () => matchAppointments(customer, state.appointments),
    [customer, state.appointments],
  );
  const openAppts = useMemo(
    () => appts
      .filter((a) => a.status === 'scheduled' || a.status === 'checked-in')
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)),
    [appts],
  );

  async function handleDelete() {
    if (!confirm(`Delete ${displayCustomerName(customer)}? This can't be undone.`)) return;
    const ok = await deleteCustomer(customer.id);
    if (ok) onDeleted();
  }

  const totalSpentCents = tickets
    .filter((t) => t.status === 'closed')
    .reduce((s, t) => s + (t.totalCents ?? 0), 0);

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 font-mono text-xs font-semibold text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft size={14} /> ALL CUSTOMERS
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={onEdit}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50 font-mono text-xs font-bold"
          >
            <Edit3 size={12} /> EDIT
          </button>
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 font-mono text-xs font-bold"
          >
            <Trash2 size={12} /> DELETE
          </button>
        </div>
      </div>

      {/* Header card */}
      <div className="bg-white rounded-2xl border border-gray-100 p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-bebas text-3xl tracking-[3px] text-gray-900">
            {displayCustomerName(customer)}
          </h2>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-1 font-mono text-xs text-gray-600">
            {customer.phone && <span className="flex items-center gap-1.5"><Phone size={12} className="text-gray-400" />{formatPhone(customer.phone)}</span>}
            {customer.email && <span className="flex items-center gap-1.5"><Mail size={12} className="text-gray-400" />{customer.email}</span>}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4 text-right">
          <div>
            <div className="font-mono text-[10px] tracking-wider font-bold text-gray-400 uppercase">Tickets</div>
            <div className="font-mono text-xl font-bold text-gray-900">{tickets.filter((t) => t.status === 'closed').length}</div>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-wider font-bold text-gray-400 uppercase">Spent</div>
            <div className="font-mono text-xl font-bold text-emerald-600">{formatMoneyCents(totalSpentCents)}</div>
          </div>
          <div>
            <div className="font-mono text-[10px] tracking-wider font-bold text-gray-400 uppercase">Open Appts</div>
            <div className="font-mono text-xl font-bold text-gray-900">{openAppts.length}</div>
          </div>
        </div>
      </div>

      {/* Popup note callout */}
      {customer.popupNote && (
        <div className="rounded-2xl bg-amber-50 border border-amber-200 px-4 py-3 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10px] tracking-wider font-bold text-amber-700 uppercase">Pop-up Note</div>
            <p className="font-mono text-sm text-amber-900 whitespace-pre-wrap break-words">{customer.popupNote}</p>
          </div>
        </div>
      )}

      {/* General notes */}
      {customer.notes && (
        <div className="rounded-2xl bg-white border border-gray-100 px-4 py-3 flex items-start gap-3">
          <StickyNote size={16} className="text-gray-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10px] tracking-wider font-bold text-gray-400 uppercase">Notes</div>
            <p className="font-mono text-sm text-gray-700 whitespace-pre-wrap break-words">{customer.notes}</p>
          </div>
        </div>
      )}

      {/* Open appointments */}
      <Section title="OPEN APPOINTMENTS" subtitle={`${openAppts.length} upcoming`} icon={<Calendar size={14} />}>
        {openAppts.length === 0 ? (
          <Empty text="No open appointments." />
        ) : (
          <div>
            <div className="grid grid-cols-[120px_80px_1fr_1fr_100px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Date</span>
              <span>Time</span>
              <span>Services</span>
              <span>Notes</span>
              <span className="text-right">Status</span>
            </div>
            {openAppts.map((a) => (
              <div key={a.id} className="grid grid-cols-[120px_80px_1fr_1fr_100px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center">
                <span className="font-mono text-xs text-gray-700">{formatDate(a.date)}</span>
                <span className="font-mono text-xs text-gray-700">{a.time || '—'}</span>
                <span className="font-mono text-xs text-gray-800 truncate">{a.services.join(', ') || a.service}</span>
                <span className="font-mono text-xs text-gray-500 truncate">{a.notes || '—'}</span>
                <span className="font-mono text-[10px] tracking-wider font-bold uppercase text-right text-gray-600">{a.status}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Ticket history */}
      <Section title="TICKET HISTORY" subtitle={`${tickets.length} total`} icon={<Receipt size={14} />}>
        {tickets.length === 0 ? (
          <Empty text={ticketsLoading ? 'Loading…' : 'No tickets on file.'} />
        ) : (
          <div>
            <div className="grid grid-cols-[80px_120px_1fr_1fr_90px_100px] gap-2 px-4 py-2 bg-gray-50 border-b border-gray-100 font-mono text-[10px] tracking-wider font-semibold text-gray-400 uppercase">
              <span>Ticket</span>
              <span>Date</span>
              <span>Staff</span>
              <span>Services</span>
              <span className="text-right">Total</span>
              <span className="text-right">Status</span>
            </div>
            {tickets.slice(0, 50).map((t) => {
              const services = (t.items ?? [])
                .filter((it) => it.kind === 'service')
                .map((it) => it.name)
                .join(', ');
              return (
                <div key={t.id} className="grid grid-cols-[80px_120px_1fr_1fr_90px_100px] gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 items-center">
                  <span className="font-mono text-xs font-bold text-gray-800">#{t.ticketNumber}</span>
                  <span className="font-mono text-xs text-gray-700">{formatDate(t.businessDate)}</span>
                  <span className="font-mono text-xs text-gray-800 truncate">{t.primaryManicuristName || '—'}</span>
                  <span className="font-mono text-xs text-gray-700 truncate">{services || '—'}</span>
                  <span className="font-mono text-xs font-bold text-gray-900 text-right">{formatMoneyCents(t.totalCents)}</span>
                  <span className={`font-mono text-[10px] tracking-wider font-bold uppercase text-right ${
                    t.status === 'closed' ? 'text-gray-600' : t.status === 'voided' ? 'text-amber-600' : 'text-emerald-600'
                  }`}>{t.status}</span>
                </div>
              );
            })}
            {tickets.length > 50 && (
              <div className="px-4 py-2 font-mono text-[10px] text-gray-400 text-center">
                Showing 50 of {tickets.length} — open a specific ticket from the Register for full detail.
              </div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({
  title, subtitle, icon, children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        {icon && <span className="text-gray-400">{icon}</span>}
        <h3 className="font-bebas text-lg tracking-[2px] text-gray-800">{title}</h3>
        {subtitle && <span className="font-mono text-[10px] text-gray-400">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="px-4 py-6 text-center font-mono text-xs text-gray-400">{text}</div>
  );
}

// ── Form view ────────────────────────────────────────────────────────────────

function CustomerFormScreen({
  customer, onCancel, onSaved,
}: {
  customer: Customer | null;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const [first, setFirst] = useState(customer?.firstName ?? '');
  const [last, setLast] = useState(customer?.lastName ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [popupNote, setPopupNote] = useState(customer?.popupNote ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!customer;
  const canSave = !busy && (first.trim().length > 0 || last.trim().length > 0 || normalizePhone(phone).length > 0);

  async function handleSave() {
    setError(null);
    if (!canSave) {
      setError('Provide at least a name or phone number.');
      return;
    }
    setBusy(true);
    const payload: CustomerInput = {
      firstName: first,
      lastName: last,
      phone,
      email,
      notes,
      popupNote,
    };
    const saved = isEdit && customer
      ? await updateCustomer(customer.id, payload)
      : await createCustomer(payload);
    setBusy(false);
    if (!saved) {
      setError('Could not save — try again.');
      return;
    }
    onSaved(saved.id);
  }

  return (
    <div className="p-6 overflow-y-auto h-full space-y-5">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 font-mono text-xs font-semibold text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft size={14} /> {isEdit ? 'CANCEL' : 'ALL CUSTOMERS'}
        </button>
        <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">
          {isEdit ? 'EDIT CUSTOMER' : 'NEW CUSTOMER'}
        </h2>
        <div />
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 p-6 space-y-4 max-w-3xl mx-auto w-full">
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <input value={first} onChange={(e) => setFirst(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Last name">
            <input value={last} onChange={(e) => setLast(e.target.value)} className={inputCls} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Phone">
            <input
              type="tel" inputMode="tel" value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(555) 555-5555"
              className={inputCls}
            />
          </Field>
          <Field label="Email">
            <input
              type="email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Pop-up note" hint="Appears when this customer is selected during appointment booking. Leave blank for none.">
          <textarea
            value={popupNote} onChange={(e) => setPopupNote(e.target.value)}
            rows={2}
            placeholder="e.g. Allergic to acetone — use non-acetone remover."
            className={`${inputCls} resize-y`}
          />
        </Field>
        <Field label="General notes" hint="Always visible on the profile.">
          <textarea
            value={notes} onChange={(e) => setNotes(e.target.value)}
            rows={4}
            className={`${inputCls} resize-y`}
          />
        </Field>
        {error && <p className="font-mono text-xs text-red-500">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 font-mono text-xs font-bold hover:bg-gray-50"
          >
            CANCEL
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-2 rounded-lg bg-pink-600 text-white font-mono text-xs font-bold hover:bg-pink-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'SAVING…' : isEdit ? 'SAVE CHANGES' : 'CREATE CUSTOMER'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full px-3 py-2 rounded-lg border border-gray-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-pink-300';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      {children}
      {hint && <span className="font-mono text-[10px] text-gray-400">{hint}</span>}
    </label>
  );
}

// Re-export normalizeName so the lib doesn't get an "unused" lint hit when
// callers only need the matching helpers indirectly via the screen.
export { normalizeName };
