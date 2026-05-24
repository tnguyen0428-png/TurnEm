import { useState } from 'react';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import ClientForm from './ClientForm';
import type { ClientFormData } from './ClientForm';
import type { QueueEntry } from '../../types';
import { upsertCustomerFromIntake, splitClientName } from '../../lib/customers';
import { getLocalDateStr } from '../../utils/time';

// Normalize a name for "same client" comparison: trim + collapse internal
// whitespace + lowercase. So "Sally  " === "sally" === "Sally".
function normName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Strip a trailing " <digits>" suffix so "Sally 3" → "Sally". Used so we
// always count duplicates against the bare base name, regardless of which
// numbered variant the cashier typed in.
function stripSuffix(s: string): string {
  return s.trim().replace(/\s+\d+$/, '');
}

// Build the suggested numbered name. If the bare base "Sally" is already
// in-salon (with or without numbered siblings), return the next free
// "Sally N" — N starts at 2 because the original counts as #1.
function pickNextSuffix(baseName: string, existing: string[]): string {
  const bare = stripSuffix(baseName);
  const bareKey = normName(bare);
  if (!bareKey) return baseName.trim();
  const taken = new Set<number>();
  for (const n of existing) {
    const tNorm = normName(n);
    if (tNorm === bareKey) {
      taken.add(1);
      continue;
    }
    // Match "<base> <digits>" where <base> normalizes to the bare key.
    const m = n.trim().match(/^(.*?)\s+(\d+)$/);
    if (m && normName(m[1]) === bareKey) {
      const num = parseInt(m[2], 10);
      if (Number.isFinite(num) && num >= 1) taken.add(num);
    }
  }
  let next = 2;
  while (taken.has(next)) next++;
  return `${bare} ${next}`;
}

export default function AddClientModal() {
  const { state, dispatch } = useApp();
  // Pending duplicate-name confirmation. When the cashier types a name that
  // exactly matches an in-salon client (today's queue or today's completed),
  // we stash the form data + the auto-numbered suggestion here and render
  // the ConfirmDialog. Cleared on confirm OR cancel.
  const [pendingDup, setPendingDup] = useState<{
    data: ClientFormData;
    suggestedName: string;
  } | null>(null);

  function commit(data: ClientFormData, overrideName?: string) {
    const clientName = overrideName ?? data.clientName;
    // ClientForm stamps clientRequest === true on every entry it emits.
    // Filter on that flag so only real customer requests count.
    const hasAnyRequest = data.serviceRequests.some((r) => r.clientRequest === true && r.manicuristIds.length > 0);
    const firstRequestedId = data.serviceRequests.find((r) => r.clientRequest === true && r.manicuristIds.length > 0)?.manicuristIds[0] ?? null;

    const newClient: QueueEntry = {
      id: crypto.randomUUID(),
      clientName,
      services: data.services,
      turnValue: data.turnValue,
      serviceRequests: data.serviceRequests,
      requestedManicuristId: firstRequestedId,
      isRequested: hasAnyRequest,
      isAppointment: data.isAppointment,
      assignedManicuristId: null,
      status: 'waiting',
      arrivedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      extraTimeMs: 0,
    };

    dispatch({ type: 'ADD_CLIENT', client: newClient });
    dispatch({ type: 'SET_MODAL', modal: null });
    // Fire-and-forget customer profile upsert so the Blueprint → Customers
    // list auto-fills as the salon takes walk-ins. Failure is non-blocking;
    // the queue entry is already saved by the dispatch above.
    const { firstName, lastName } = splitClientName(clientName);
    void upsertCustomerFromIntake({ firstName, lastName });
  }

  function handleSubmit(data: ClientFormData) {
    const entered = data.clientName.trim();
    if (entered) {
      // "In-salon today" = currently in the queue (waiting / inProgress) +
      // anything completed today. Both are visible to the cashier in the
      // floor view, so a name collision here is genuinely a name the
      // cashier is about to see twice.
      const today = getLocalDateStr(new Date());
      const queueNames = state.queue.map((q) => q.clientName);
      const completedToday = state.completed
        .filter((c) => {
          if (c.voided) return false;
          // completedAt may be null for an open-ticket assignment that
          // hasn't been finalized — those are still "in salon", so include
          // them. For dated completions, filter to today's LA date.
          if (c.completedAt == null) return true;
          return getLocalDateStr(new Date(c.completedAt)) === today;
        })
        .map((c) => c.clientName);
      const allInSalon = [...queueNames, ...completedToday];
      const enteredKey = normName(entered);
      const exactMatch = allInSalon.some((n) => normName(n) === enteredKey);
      if (exactMatch) {
        const suggested = pickNextSuffix(entered, allInSalon);
        setPendingDup({ data, suggestedName: suggested });
        return;
      }
    }
    commit(data);
  }

  return (
    <>
      <Modal title="ADD CLIENT" onClose={() => dispatch({ type: 'SET_MODAL', modal: null })}>
        <ClientForm
          salonServices={state.salonServices}
          manicurists={state.manicurists}
          submitLabel="ADD TO QUEUE"
          onSubmit={handleSubmit}
        />
      </Modal>
      {pendingDup && (
        <ConfirmDialog
          message={`A client named "${pendingDup.data.clientName.trim()}" is already in the salon. Save as "${pendingDup.suggestedName}"?`}
          confirmLabel={`Save as ${pendingDup.suggestedName}`}
          onConfirm={() => {
            const { data, suggestedName } = pendingDup;
            setPendingDup(null);
            commit(data, suggestedName);
          }}
          onCancel={() => setPendingDup(null)}
        />
      )}
    </>
  );
}
