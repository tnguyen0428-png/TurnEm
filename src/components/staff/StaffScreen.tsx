import { useState } from 'react';
import { Plus, Pencil, Trash2, Users, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import Badge from '../shared/Badge';
import EmptyState from '../shared/EmptyState';
import ConfirmDialog from '../shared/ConfirmDialog';
import { supabase } from '../../lib/supabase';

const MAX_VISIBLE_SKILLS = 3;

export default function StaffScreen() {
  const { state, dispatch } = useApp();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());

  async function confirmDelete() {
    if (deleteId) {
      await supabase.from('manicurists').delete().eq('id', deleteId);
      dispatch({ type: 'DELETE_MANICURIST', id: deleteId });
      setDeleteId(null);
    }
  }

  function getStatusVariant(status: string): 'green' | 'red' | 'amber' | 'gray' {
    switch (status) {
      case 'available': return 'green';
      case 'busy': return 'red';
      case 'break': return 'amber';
      default: return 'gray';
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">STAFF MANAGEMENT</h2>
        <button
          onClick={() => dispatch({ type: 'SET_MODAL', modal: 'addStaff' })}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-pink-500 text-white font-mono text-xs font-semibold hover:bg-pink-600 active:scale-[0.98] transition-all"
        >
          <Plus size={14} />
          ADD MANICURIST
        </button>
      </div>

      {state.manicurists.length === 0 ? (
        <EmptyState
          icon={<Users size={48} />}
          title="No staff members"
          description="Add your manicurists to get started"
        />
      ) : (
        <div className="space-y-3">
          {[...state.manicurists].sort((a, b) => a.name.localeCompare(b.name)).map((m) => (
            <div
              key={m.id}
              className="bg-white rounded-xl border border-gray-100 p-4 hover:shadow-md transition-all duration-200"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-bebas text-lg"
                    style={{ backgroundColor: m.color }}
                  >
                    {m.name.charAt(0)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-mono text-sm font-semibold text-gray-900">{m.name}</h3>
                      <Badge
                        label={m.clockedIn ? m.status.toUpperCase() : 'OFF'}
                        variant={m.clockedIn ? getStatusVariant(m.status) : 'gray'}
                      />
                      {m.phone && (
                        <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-500" title={`SMS: ${m.phone}`}>
                          <MessageSquare size={10} />
                          SMS
                        </span>
                      )}
                    </div>
                    {m.skills.length > 0 && (
                      <div className="mt-1.5">
                        <div className="flex flex-wrap gap-1 items-center">
                          {(expandedSkills.has(m.id) ? m.skills : m.skills.slice(0, MAX_VISIBLE_SKILLS)).map((skill) => (
                            <span
                              key={skill}
                              className="inline-block px-2 py-0.5 rounded-md bg-gray-50 text-[10px] font-mono text-gray-500"
                            >
                              {skill}
                            </span>
                          ))}
                          {m.skills.length > MAX_VISIBLE_SKILLS && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpandedSkills(prev => {
                                  const next = new Set(prev);
                                  if (next.has(m.id)) next.delete(m.id);
                                  else next.add(m.id);
                                  return next;
                                });
                              }}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[10px] font-mono text-pink-500 hover:bg-pink-50 transition-colors"
                            >
                              {expandedSkills.has(m.id) ? (
                                <>Less <ChevronUp size={10} /></>
                              ) : (
                                <>+{m.skills.length - MAX_VISIBLE_SKILLS} more <ChevronDown size={10} /></>
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-gray-400 mr-2">
                    {m.totalTurns.toFixed(1)} turns
                  </span>
                  <button
                    onClick={() => {
                      dispatch({ type: 'SET_EDITING_STAFF', staffId: m.id });
                      dispatch({ type: 'SET_MODAL', modal: 'editStaff' });
                    }}
                    className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => setDeleteId(m.id)}
                    className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {deleteId && (
        <ConfirmDialog
          message="Delete this manicurist? This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={confirmDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}
