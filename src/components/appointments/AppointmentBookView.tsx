import { useRef, useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import { SERVICE_TURN_VALUES } from '../../constants/services';
import type { Appointment, Manicurist, QueueEntry, ServiceType } from '../../types';

const START_HOUR   = 8;
const END_HOUR     = 20;
const SLOT_MINUTES = 15;
const SLOT_HEIGHT  = 34;
const COL_WIDTH    = 96;           // narrower columns
const TIME_COL_W   = 56;
const HEADER_H     = 48;

const TOTAL_SLOTS = ((END_HOUR - START_HOUR) * 60) / SLOT_MINUTES;
const TOTAL_H     = TOTAL_SLOTS * SLOT_HEIGHT;

// Pastel palette — one per appointment (consistent across all its service blocks)
const APPT_PALETTES = [
  { bg: '#fce7f3', border: '#f472b6' }, // pink
  { bg: '#ede9fe', border: '#a78bfa' }, // purple
  { bg: '#dbeafe', border: '#60a5fa' }, // blue
  { bg: '#d1fae5', border: '#34d399' }, // green
  { bg: '#fef3c7', border: '#fbbf24' }, // amber
  { bg: '#fee2e2', border: '#f87171' }, // red
  { bg: '#e0f2fe', border: '#38bdf8' }, // sky
  { bg: '#fdf4ff', border: '#e879f9' }, // fuchsia
  { bg: '#f0fdf4', border: '#4ade80' }, // emerald
  { bg: '#fff7ed', border: '#fb923c' }, // orange
];

// Color by client name so all of one client's services share the same color
function apptPalette(appt: Appointment) {
  const key = (appt.clientName || '').trim().toLowerCase() || appt.id;
  let hash = 0;
  for (const c of key) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return APPT_PALETTES[Math.abs(hash) % APPT_PALETTES.length];
}

function slotToTime(i: number): string {
  const m = START_HOUR * 60 + i * SLOT_MINUTES;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function timeToTopPx(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return ((h - START_HOUR) * 60 + m) / SLOT_MINUTES * SLOT_HEIGHT;
}

function hourLabel(i: number): string | null {
  const totalMins = START_HOUR * 60 + i * SLOT_MINUTES;
  const m = totalMins % 60;
  if (m !== 0) return null;
  const h = Math.floor(totalMins / 60);
  if (h === 12) return '12 PM';
  if (h > 12) return `${h - 12} PM`;
  return `${h} AM`;
}

function slotType(i: number): 'hour' | 'half' | 'quarter' {
  const m = (START_HOUR * 60 + i * SLOT_MINUTES) % 60;
  if (m === 0) return 'hour';
  if (m === 30) return 'half';
  return 'quarter';
}

function fmtTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

interface ServiceBlock {
  appt: Appointment;
  serviceName: string;
  occurrence: number;    // which instance of this service name (0=first, 1=second...)
  blockTime: string;     // actual HH:MM time this block is positioned at
  duration: number;
  top: number;
  height: number;
  isFirst: boolean;      // first service of this appt in this column
  isApptFirst: boolean;  // very first service of this appt across all columns
  colManicuristId: string | null;
  hasRequest: boolean;
  requestedManicuristId: string | null; // who the client requested (null if no request)
}

interface DragInfo { apptId: string; serviceName: string; occurrence: number }
interface PendingDrop { info: DragInfo; mId: string | null; slot: number }
interface Props { selectedDate: string }

export default function AppointmentBookView({ selectedDate }: Props) {
  const { state, dispatch } = useApp();
  const scrollRef    = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const [cannotParkMsg, setCannotParkMsg] = useState<string | null>(null);

  // Keep top scrollbar in sync with main grid
  const onMainScroll = useCallback(() => {
    if (topScrollRef.current && scrollRef.current)
      topScrollRef.current.scrollLeft = scrollRef.current.scrollLeft;
  }, []);
  const onTopScroll = useCallback(() => {
    if (scrollRef.current && topScrollRef.current)
      scrollRef.current.scrollLeft = topScrollRef.current.scrollLeft;
  }, []);

  const manicurists = state.manicurists.filter((m) => m.showInBook !== false);
  const totalGridW  = TIME_COL_W + manicurists.length * COL_WIDTH;
  const dayAppts    = state.appointments.filter(
    (a) => a.date === selectedDate && a.status !== 'cancelled' && a.status !== 'no-show'
  );

  const [dragInfo, setDragInfo]       = useState<DragInfo | null>(null);
  const [dropTarget, setDropTarget]   = useState<{ mId: string | null; slot: number } | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);

  function svcDuration(name: string): number {
    return state.salonServices.find((s) => s.name === name)?.duration || 60;
  }

  function getApptSvcs(appt: Appointment): string[] {
    return (appt.services?.length ? appt.services : [appt.service as string]).filter(Boolean);
  }


  function getServiceBlocks(mId: string | null): ServiceBlock[] {
    const blocks: ServiceBlock[] = [];

    for (const appt of dayAppts) {
      const svcs = getApptSvcs(appt);
      const allReqs = appt.serviceRequests || [];
      const [startH, startM] = appt.time.split(':').map(Number);

      // Track occurrence counts per service name for positional matching
      const occurrenceCount: Record<string, number> = {};
      // Track offset only within THIS column (parallel services in other columns don't add offset)
      let colOffsetMins = 0;
      let isFirst = true;

      for (let i = 0; i < svcs.length; i++) {
        const svcName = svcs[i];
        const occ = occurrenceCount[svcName] ?? 0;
        occurrenceCount[svcName] = occ + 1;

        // Find the (occ)-th serviceRequest for this service name
        const reqsForSvc = allReqs.filter((r) => r.service === svcName);
        const req = reqsForSvc[occ] ?? null;

        // Determine which column this service belongs to
        let assignedMId: string | null;
        if (req && req.manicuristIds.length > 0) {
          assignedMId = req.manicuristIds[0];
        } else if (req && req.manicuristIds.length === 0) {
          assignedMId = null; // explicitly unassigned
        } else {
          // No serviceRequest — falls back to appointment's manicuristId column,
          // but ONLY if that manicurist has the skill for this service.
          const fallbackMId = appt.manicuristId ?? null;
          const colMani = fallbackMId ? state.manicurists.find((m) => m.id === fallbackMId) : null;
          const hasSkill = !colMani || colMani.skills.length === 0 || colMani.skills.includes(svcName);
          assignedMId = (hasSkill && fallbackMId) ? fallbackMId : null;
        }

        if (assignedMId !== mId) continue; // skip services not in this column

        const dur = svcDuration(svcName);

        // Per-service time: use explicit startTime if set (from drag), else appt time + column offset
        let blockTopPx: number;
        let blockTime: string;
        if (req?.startTime) {
          blockTopPx = timeToTopPx(req.startTime);
          blockTime  = req.startTime;
        } else {
          const startMins = (startH - START_HOUR) * 60 + startM + colOffsetMins;
          blockTopPx = startMins / SLOT_MINUTES * SLOT_HEIGHT;
          // Convert back to HH:MM string
          const totalMins = startH * 60 + startM + colOffsetMins;
          blockTime = `${String(Math.floor(totalMins / 60)).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}`;
        }

        const height     = Math.max(dur / SLOT_MINUTES * SLOT_HEIGHT - 3, 20);
        const isApptFirst = isFirst && i === 0;
        const hasRequest  = !!(req && req.manicuristIds.length > 0 && req.clientRequest === true);
        const requestedManicuristId = hasRequest ? (req!.manicuristIds[0] ?? null) : null;

        blocks.push({ appt, serviceName: svcName, occurrence: occ, blockTime, duration: dur,
          top: blockTopPx, height, isFirst, isApptFirst, colManicuristId: mId,
          hasRequest, requestedManicuristId });

        // Only accumulate offset for services stacking in THIS column
        if (!req?.startTime) colOffsetMins += dur;
        isFirst = false;
      }
    }
    return blocks;
  }

  function removeSvcFromAppt(appt: Appointment, svcName: string) {
    // Only remove the FIRST occurrence so duplicate services stay independent
    const all = getApptSvcs(appt);
    const firstIdx = all.indexOf(svcName);
    const svcs = firstIdx >= 0 ? [...all.slice(0, firstIdx), ...all.slice(firstIdx + 1)] : all;
    if (svcs.length === 0) {
      dispatch({ type: 'DELETE_APPOINTMENT', id: appt.id });
    } else {
      const newReqs = (appt.serviceRequests || []).filter((r) => r.service !== svcName);
      dispatch({ type: 'UPDATE_APPOINTMENT', id: appt.id, updates: {
        services: svcs, service: svcs[0] as ServiceType,
        serviceRequests: newReqs,
        manicuristId: newReqs[0]?.manicuristIds?.[0] ?? appt.manicuristId ?? null,
      }});
    }
  }

  function deleteSvcBlock(e: React.MouseEvent, appt: Appointment, svcName: string) {
    e.stopPropagation();
    removeSvcFromAppt(appt, svcName);
  }

  function addApptToQueue(e: React.MouseEvent, appt: Appointment) {
    e.stopPropagation();
    dispatch({ type: 'DELETE_APPOINTMENT', id: appt.id });
    const services = getApptSvcs(appt) as ServiceType[];
    const serviceRequests = (appt.serviceRequests || []).length > 0
      ? appt.serviceRequests
      : appt.manicuristId ? [{ service: services[0], manicuristIds: [appt.manicuristId] }] : [];
    const isRequested      = serviceRequests.some((r) => r.manicuristIds.length > 0);
    const firstRequestedId = serviceRequests[0]?.manicuristIds?.[0] ?? null;
    const turnValue = services.reduce((sum, svc) => {
      const s = state.salonServices.find((ss) => ss.name === svc);
      const base = s?.turnValue ?? SERVICE_TURN_VALUES[svc] ?? 1;
      const hasReq = serviceRequests.some((r) => r.service === svc && r.manicuristIds.length > 0);
      return sum + (hasReq && base > 0 ? (s?.category === 'Combo' ? 1 : 0.5) : base);
    }, 0);
    dispatch({ type: 'ADD_CLIENT', client: {
      id: crypto.randomUUID(), clientName: appt.clientName || 'Walk-in',
      services, turnValue, serviceRequests, requestedManicuristId: firstRequestedId,
      isRequested, isAppointment: true, assignedManicuristId: null, status: 'waiting',
      arrivedAt: Date.now(), startedAt: null, completedAt: null, extraTimeMs: 0,
    } as QueueEntry });
  }

  // Drag changes TIME and COLUMN independently per service occurrence.
  // Same column → time only. Different column → also updates that service's assignment.
  function executeDrop(info: DragInfo, mId: string | null, slot: number) {
    const { apptId, serviceName, occurrence } = info;
    const appt = state.appointments.find((a) => a.id === apptId);
    if (!appt) return;
    const newTime = slotToTime(slot);
    const allReqs = appt.serviceRequests || [];

    // Find what column this occurrence is currently in
    const reqsForSvc = allReqs.filter((r) => r.service === serviceName);
    const currentReq = reqsForSvc[occurrence] ?? null;
    // Build the new serviceRequest entry for this service occurrence
    const allIdxsForSvc = allReqs.reduce<number[]>((acc, r, i) => {
      if (r.service === serviceName) acc.push(i);
      return acc;
    }, []);
    const targetIdx = allIdxsForSvc[occurrence];

    // Determine the startTime to store:
    // - If column changed → store explicit startTime so this service has its own position
    // - If same column → store startTime to record the new time
    // First appointment's service also updates appt.time for the default
    const isFirstService = occurrence === 0 && serviceName === appt.services?.[0];

    const newEntry = {
      service: serviceName as ServiceType,
      manicuristIds: mId ? [mId] : (currentReq?.manicuristIds ?? []),
      clientRequest: (currentReq?.clientRequest ?? false) as boolean,
      startTime: newTime,
    };

    let updatedReqs = [...allReqs];
    if (targetIdx !== undefined) {
      updatedReqs = updatedReqs.map((r, i) => i === targetIdx ? newEntry : r);
    } else {
      updatedReqs = [...updatedReqs, newEntry];
    }

    const updates: Partial<typeof appt> = { serviceRequests: updatedReqs };
    // Update appointment-level time only if this is the first/primary service
    if (isFirstService) updates.time = newTime;

    dispatch({ type: 'UPDATE_APPOINTMENT', id: apptId, updates });
  }

  function onDragStart(e: React.DragEvent, appt: Appointment, svcName: string, occurrence: number) {
    e.stopPropagation();
    const info: DragInfo = { apptId: appt.id, serviceName: svcName, occurrence };
    setDragInfo(info);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify(info));
  }

  function onSlotDragOver(e: React.DragEvent, mId: string | null, slot: number) {
    if (!dragInfo) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget({ mId, slot });
  }

  function onSlotDrop(e: React.DragEvent, mId: string | null, slot: number) {
    e.preventDefault();
    let info: DragInfo | null = null;
    try { info = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { info = dragInfo; }
    if (!info) return;
    setDragInfo(null);
    setDropTarget(null);

    // Check if target column's manicurist can do this service
    if (mId !== null) {
      const colMani = state.manicurists.find((m) => m.id === mId);
      if (colMani && colMani.skills.length > 0 && !colMani.skills.includes(info.serviceName)) {
        setCannotParkMsg(`${colMani.name} does not do ${info.serviceName}`);
        setTimeout(() => setCannotParkMsg(null), 3000);
        return;
      }
    }

    executeDrop(info!, mId, slot);
  }

  function onDragEnd() { setDragInfo(null); setDropTarget(null); }

  // Current time
  const todayKey = new Date().toISOString().split('T')[0];
  const isToday  = selectedDate === todayKey;
  const now      = new Date();
  const nowMins  = isToday ? (now.getHours() - START_HOUR) * 60 + now.getMinutes() : null;
  const nowTopPx = nowMins !== null && nowMins >= 0 && nowMins <= (END_HOUR - START_HOUR) * 60
    ? nowMins / SLOT_MINUTES * SLOT_HEIGHT : null;

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = nowTopPx != null ? Math.max(0, nowTopPx - 120) : 0;
  }, [selectedDate]); // eslint-disable-line

  function openAddModal(mId: string | null, slotIdx: number) {
    dispatch({ type: 'SET_APPOINTMENT_DRAFT', draft: { date: selectedDate, time: slotToTime(slotIdx), manicuristId: mId } });
    dispatch({ type: 'SET_MODAL', modal: 'addAppointment' });
  }

  function openEditModal(appt: Appointment) {
    dispatch({ type: 'SET_EDITING_APPOINTMENT', appointmentId: appt.id });
    dispatch({ type: 'SET_MODAL', modal: 'editAppointment' });
  }

  function renderColumn(m: Manicurist | null) {
    const mId    = m ? m.id : null;
    const blocks = getServiceBlocks(mId);
    return (
      <div key={mId ?? 'any'} className="flex-shrink-0 relative border-r border-gray-200"
        style={{ width: COL_WIDTH, height: TOTAL_H }}
        onDragLeave={() => setDropTarget(null)}>

        {Array.from({ length: TOTAL_SLOTS }).map((_, i) => {
          const type     = slotType(i);
          const isHour   = type === 'hour';
          const isDropOver = dropTarget?.mId === mId && dropTarget?.slot === i && !!dragInfo;
          return (
            <div key={i}
              className={`absolute left-0 right-0 cursor-pointer group transition-colors ${isDropOver ? 'bg-pink-100 ring-1 ring-pink-400 ring-inset' : 'hover:bg-pink-50/60'}`}
              style={{
                top: i * SLOT_HEIGHT, height: SLOT_HEIGHT,
                borderTop:    isHour ? '2px solid #6b7280' : 'none',
                borderBottom: isHour ? '1px solid #e5e7eb' : type === 'half' ? '1px solid #d1d5db' : '1px solid #e5e7eb',
              }}
              onClick={() => !dragInfo && openAddModal(mId, i)}
              onDragOver={(e) => onSlotDragOver(e, mId, i)}
              onDrop={(e) => onSlotDrop(e, mId, i)}>
              {!dragInfo && <div className="absolute top-0.5 right-1 opacity-0 group-hover:opacity-100"><Plus size={9} className="text-pink-300" /></div>}
            </div>
          );
        })}

        {blocks.map((blk, idx) => {
          const { appt, serviceName, occurrence, blockTime, top, height, isFirst, hasRequest, requestedManicuristId, colManicuristId } = blk;
          const palette     = apptPalette(appt);
          const isDragging  = dragInfo?.apptId === appt.id && dragInfo?.serviceName === serviceName;
          const isCompleted = appt.status === 'completed';
          const isCheckedIn = appt.status === 'checked-in';
          const bg     = isCompleted ? '#f3f4f6' : isCheckedIn ? '#d1fae5' : palette.bg;
          const border = isCompleted ? '#9ca3af' : isCheckedIn ? '#10b981' : palette.border;
          const pl = isFirst ? '14px' : '4px';

          return (
            <div key={`${appt.id}-${serviceName}-${idx}`}
              draggable={!isCompleted}
              onDragStart={(e) => !isCompleted && onDragStart(e, appt, serviceName, occurrence)}
              onDragEnd={onDragEnd}
              className={`absolute left-1 right-1 rounded-lg overflow-hidden border-l-[3px] select-none group z-10 transition-all ${
                isDragging ? 'opacity-30 cursor-grabbing' : !isCompleted ? 'cursor-grab hover:shadow-md hover:-translate-y-px shadow-sm' : 'shadow-sm'
              } ${
                // Pulse only when requested but not yet in the right column
                hasRequest && !isCompleted && colManicuristId !== requestedManicuristId
                  ? 'ring-2 ring-pink-500 ring-offset-1 animate-pulse' : ''
              }`}
              style={{
                top: top + 1, height, backgroundColor: bg, borderLeftColor: border,
                borderTop: `1px solid ${border}60`, borderRight: `1px solid ${border}40`, borderBottom: `1px solid ${border}40`,
              }}
              onClick={() => !isDragging && openEditModal(appt)}>

              <div className="px-1.5 py-1 h-full flex flex-col overflow-hidden gap-0.5">
                {/* Client name on every block */}
                <div className="flex items-center gap-1 min-w-0">
                  {!isCompleted && <GripVertical size={10} className="text-gray-400 flex-shrink-0 cursor-grab" />}
                  <p className="font-mono text-[13px] font-bold truncate leading-tight flex-1"
                    style={{ color: isCompleted ? '#9ca3af' : '#111827' }}>
                    {appt.clientName || 'Walk-in'}
                  </p>
                </div>

                {/* Service name + R badge */}
                <div className="flex items-center gap-1 min-w-0" style={{ paddingLeft: pl }}>
                  <p className="font-mono text-xs font-semibold truncate leading-tight flex-1"
                    style={{ color: isCompleted ? '#9ca3af' : border }}>
                    {serviceName}
                  </p>
                  {hasRequest && (
                    <span className="flex-shrink-0 px-1.5 py-0.5 rounded-md font-mono text-[8px] font-bold bg-pink-500 text-white leading-none tracking-wide">REQ</span>
                  )}
                </div>

                {height > 56 && (
                  <p className="font-mono text-[11px] text-gray-500 truncate leading-tight" style={{ paddingLeft: pl }}>
                    {fmtTime(blockTime)}
                  </p>
                )}

                {/* Action buttons on hover */}
                {/* Action buttons — on every service block */}
                {height > 36 && !isCompleted && (
                  <div className="flex gap-1 mt-auto opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ paddingLeft: pl }}
                    onClick={(e) => e.stopPropagation()}>
                    {/* Q — queues the whole appointment */}
                    {appt.status === 'scheduled' && (
                      <button onClick={(e) => addApptToQueue(e, appt)}
                        title="Send whole appointment to waiting queue"
                        className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 font-mono text-[10px] font-bold">
                        Q
                      </button>
                    )}
                    {/* Edit — opens appointment modal */}
                    <button onClick={(e) => { e.stopPropagation(); openEditModal(appt); }}
                      title="Edit appointment"
                      className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 font-mono text-[9px] font-bold">
                      ✎
                    </button>
                    {/* Delete — removes just this service */}
                    <button onClick={(e) => deleteSvcBlock(e, appt, serviceName)}
                      title="Remove this service"
                      className="p-0.5 rounded bg-red-100 text-red-500 hover:bg-red-200">
                      <Trash2 size={9} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // No ANY column — unassigned services park in list view, not on the book
  const columns: (Manicurist | null)[] = [...manicurists];

  return (
    <>
      <div ref={scrollRef} onScroll={onMainScroll} style={{ height: '100%', overflowX: 'auto', overflowY: 'auto' }}>
        <div style={{
          minWidth: totalGridW }}>

          {/* Mirrored top scrollbar */}
          <div ref={topScrollRef} onScroll={onTopScroll}
            className="sticky top-0 z-40 overflow-x-auto overflow-y-hidden bg-gray-100 border-b border-gray-200"
            style={{ height: 10, cursor: 'ew-resize' }}>
            <div style={{ width: totalGridW, height: 1 }} />
          </div>

          {/* Header */}
          <div className="sticky top-[10px] z-30 flex bg-white border-b-2 border-gray-300 shadow-sm" style={{ height: HEADER_H }}>
            <div className="flex-shrink-0 sticky left-0 z-40 bg-white border-r border-gray-300 flex items-end justify-end pb-2 pr-2" style={{ width: TIME_COL_W }}>
              <span className="font-mono text-[9px] text-gray-400 tracking-widest">TIME</span>
            </div>
            {columns.map((m) => {
              const mId = m ? m.id : null;
              const cnt = new Set(getServiceBlocks(mId).map((b) => b.appt.id)).size;
              return (
                <div key={mId ?? 'any'} className="flex-shrink-0 flex items-center gap-1.5 px-2 border-r border-gray-200" style={{ width: COL_WIDTH }}>
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: m ? m.color : '#d1d5db' }} />
                  <span className="font-mono text-[13px] font-bold text-gray-700 truncate flex-1">{m ? m.name : 'ANY'}</span>
                  {cnt > 0 && <span className="font-mono text-[9px] text-white bg-pink-400 rounded-full w-4 h-4 flex items-center justify-center flex-shrink-0">{cnt}</span>}
                </div>
              );
            })}
          </div>

          {/* Body */}
          <div className="flex relative" style={{ height: TOTAL_H }}>
            <div className="flex-shrink-0 sticky left-0 z-20 bg-white border-r border-gray-300" style={{ width: TIME_COL_W }}>
              {Array.from({ length: TOTAL_SLOTS }).map((_, i) => {
                const label = hourLabel(i);
                const isHour = slotType(i) === 'hour';
                return (
                  <div key={i} className="flex items-start justify-end pr-2 pt-0.5"
                    style={{ height: SLOT_HEIGHT, borderTop: isHour ? '2px solid #6b7280' : 'none', borderBottom: isHour ? '1px solid #e5e7eb' : slotType(i) === 'half' ? '1px solid #d1d5db' : '1px solid #e5e7eb' }}>
                    {label && <span className="font-mono text-[11px] text-gray-700 leading-none whitespace-nowrap font-bold">{label}</span>}
                  </div>
                );
              })}
            </div>
            {nowTopPx != null && (
              <div className="absolute z-20 pointer-events-none flex items-center" style={{ top: nowTopPx, left: TIME_COL_W, right: 0 }}>
                <div className="w-2.5 h-2.5 rounded-full bg-red-500 shadow-sm -ml-1.5 flex-shrink-0" />
                <div className="flex-1 h-[2px] bg-red-400" style={{ opacity: 0.8 }} />
              </div>
            )}
            {columns.map((m) => renderColumn(m))}
          </div>
        </div>
      </div>

      {/* Cannot park here popup */}
      {cannotParkMsg && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          <div className="bg-gray-900 text-white font-mono text-sm font-semibold px-5 py-3 rounded-2xl shadow-2xl flex items-center gap-3">
            <span className="text-red-400 text-lg">&#x26D4;</span>
            Cannot park here \u2014 {cannotParkMsg}
          </div>
        </div>
      )}

      {/* Pending drop confirmation for client-requested services */}
      {pendingDrop && (() => {
        const targetMani = pendingDrop.mId ? state.manicurists.find((m) => m.id === pendingDrop.mId) : null;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPendingDrop(null)}>
            <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-bebas text-xl tracking-[2px] text-gray-900 mb-2">MOVE REQUESTED SERVICE?</h3>
              <p className="font-mono text-sm text-gray-500 mb-1">
                <span className="font-semibold text-gray-700">{pendingDrop.info.serviceName}</span> was requested for a specific manicurist.
              </p>
              {targetMani && <p className="font-mono text-sm text-gray-500 mb-4">Moving to <span className="font-semibold" style={{ color: targetMani.color }}>{targetMani.name}</span> at {fmtTime(slotToTime(pendingDrop.slot))}.</p>}
              <p className="font-mono text-xs text-amber-600 bg-amber-50 rounded-xl px-3 py-2 mb-4">\u26a0 The client requested a specific technician for this service.</p>
              <div className="flex gap-3">
                <button onClick={() => setPendingDrop(null)} className="flex-1 py-2.5 rounded-xl border border-gray-200 font-mono text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">KEEP ORIGINAL</button>
                <button onClick={() => { executeDrop(pendingDrop.info, pendingDrop.mId, pendingDrop.slot); setPendingDrop(null); }} className="flex-1 py-2.5 rounded-xl bg-amber-500 text-white font-mono text-sm font-semibold hover:bg-amber-600 transition-colors">MOVE ANYWAY</button>
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );
}
