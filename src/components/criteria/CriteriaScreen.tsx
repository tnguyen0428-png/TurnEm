import { useEffect } from 'react';
import { Scale, ArrowUpDown, Filter, Gift, Info } from 'lucide-react';
import { useApp } from '../../state/AppContext';
import type { TurnCriteria } from '../../types';

const DEFAULT_CRITERIA: TurnCriteria[] = [
  {
    id: 'service-priority',
    name: 'Service List Priority',
    description: 'Clients are prioritized based on the order of their services in the Services list. Services higher in the list get served first. This ensures high-priority services are never kept waiting.',
    priority: 1,
    enabled: true,
    type: 'sort',
    value: 0,
  },
  {
    id: 'skill-match',
    name: 'Skill Match + Lowest Turns',
    description: 'Only manicurists with the matching skill are eligible. Among those, the one with the fewest total turns today is assigned. This ensures quality and fair workload distribution.',
    priority: 2,
    enabled: true,
    type: 'filter',
    value: 0,
  },
  {
    id: 'earliest-clock-in',
    name: 'Earliest Clock-In (Tiebreaker)',
    description: 'When two manicurists have the same number of turns, the one who clocked in earliest gets priority. Rewards punctuality.',
    priority: 3,
    enabled: true,
    type: 'sort',
    value: 0,
  },
  {
    id: 'clocked-in-only',
    name: 'Clocked-In Only',
    description: 'Only manicurists who are currently clocked in and available (not on break or busy) are eligible for assignment.',
    priority: 4,
    enabled: true,
    type: 'filter',
    value: 0,
  },
  {
    id: 'requested-bypass',
    name: 'Requested Appointment Bypass',
    description: 'When a client requests a specific manicurist, the queue is bypassed entirely. Each service counts as 0.5 turns (for services valued at 0.5 or more) instead of its normal turn value.',
    priority: 5,
    enabled: true,
    type: 'bonus',
    value: 0.5,
  },
  {
    id: 'break-exclusion',
    name: 'Break Exclusion',
    description: 'Manicurists on break are automatically excluded from the eligible pool. They become eligible again once they return from break.',
    priority: 6,
    enabled: true,
    type: 'filter',
    value: 0,
  },
];

const TYPE_ICONS: Record<TurnCriteria['type'], typeof Scale> = {
  sort: ArrowUpDown,
  filter: Filter,
  bonus: Gift,
};

const TYPE_COLORS: Record<TurnCriteria['type'], string> = {
  sort: 'bg-blue-50 text-blue-600',
  filter: 'bg-amber-50 text-amber-600',
  bonus: 'bg-pink-50 text-pink-600',
};

const TYPE_LABELS: Record<TurnCriteria['type'], string> = {
  sort: 'SORTING RULE',
  filter: 'FILTER RULE',
  bonus: 'BONUS RULE',
};

export default function CriteriaScreen() {
  const { state, dispatch } = useApp();

  useEffect(() => {
    if (state.turnCriteria.length === 0) {
      dispatch({ type: 'SET_TURN_CRITERIA', criteria: DEFAULT_CRITERIA });
    }
  }, [state.turnCriteria.length, dispatch]);

  function handleToggle(criteria: TurnCriteria) {
    if (criteria.id === 'service-priority' || criteria.id === 'skill-match' || criteria.id === 'clocked-in-only') return;
    dispatch({
      type: 'UPDATE_TURN_CRITERIA',
      criteria: { ...criteria, enabled: !criteria.enabled },
    });
  }

  function handleValueChange(criteria: TurnCriteria, newValue: number) {
    dispatch({
      type: 'UPDATE_TURN_CRITERIA',
      criteria: { ...criteria, value: newValue },
    });
  }

  const sorted = [...state.turnCriteria].sort((a, b) => a.priority - b.priority);

  return (
    <div className="max-w-3xl mx-auto p-4 sm:p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-bebas text-2xl tracking-[3px] text-gray-900">TURN CRITERIA</h2>
      </div>

      <div className="bg-blue-50 rounded-xl p-4 mb-6 flex gap-3">
        <Info size={16} className="text-blue-500 flex-shrink-0 mt-0.5" />
        <p className="font-mono text-xs text-blue-700 leading-relaxed">
          These rules define how the priority queue determines which manicurist gets the next client.
          Rules are applied in order from top to bottom. Core rules cannot be disabled.
        </p>
      </div>

      <div className="space-y-3">
        {sorted.map((criteria, idx) => {
          const Icon = TYPE_ICONS[criteria.type];
          const isCore = criteria.id === 'service-priority' || criteria.id === 'skill-match' || criteria.id === 'clocked-in-only';
          return (
            <div
              key={criteria.id}
              className={`bg-white rounded-xl border-2 transition-all duration-200 ${
                criteria.enabled
                  ? 'border-gray-100 hover:border-pink-200'
                  : 'border-gray-50 opacity-50'
              }`}
            >
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-4 flex-1">
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="font-bebas text-lg text-gray-300 w-6 text-center">
                        {idx + 1}
                      </span>
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${TYPE_COLORS[criteria.type]}`}>
                        <Icon size={16} />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="font-mono text-sm font-semibold text-gray-900">
                          {criteria.name}
                        </h3>
                        <span className={`inline-block px-2 py-0.5 rounded-full font-mono text-[9px] font-bold tracking-wider ${TYPE_COLORS[criteria.type]}`}>
                          {TYPE_LABELS[criteria.type]}
                        </span>
                        {isCore && (
                          <span className="inline-block px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-mono text-[9px] font-bold tracking-wider">
                            CORE
                          </span>
                        )}
                      </div>
                      <p className="font-mono text-xs text-gray-500 leading-relaxed">
                        {criteria.description}
                      </p>
                      {criteria.type === 'bonus' && criteria.enabled && (
                        <div className="mt-3 flex items-center gap-3">
                          <span className="font-mono text-[10px] text-gray-400 font-semibold tracking-wider">
                            TURN PENALTY:
                          </span>
                          <select
                            value={criteria.value}
                            onChange={(e) => handleValueChange(criteria, Number(e.target.value))}
                            className="px-3 py-1.5 rounded-lg border border-gray-200 font-mono text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-pink-200 bg-white"
                          >
                            <option value={0.25}>0.25 turns</option>
                            <option value={0.5}>0.5 turns</option>
                            <option value={0.75}>0.75 turns</option>
                            <option value={1.0}>1.0 turns</option>
                          </select>
                        </div>
                      )}
                    </div>
                  </div>

                  <button
                    onClick={() => handleToggle(criteria)}
                    disabled={isCore}
                    className={`flex-shrink-0 relative w-11 h-6 rounded-full transition-colors duration-200 ${
                      isCore
                        ? 'opacity-50 cursor-not-allowed'
                        : 'cursor-pointer'
                    } ${criteria.enabled ? 'bg-pink-500' : 'bg-gray-200'}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                        criteria.enabled ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 bg-white rounded-xl border border-gray-100 p-5">
        <h3 className="font-bebas text-sm tracking-[2px] text-gray-500 mb-3">TURN VALUES REFERENCE</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[
            { name: 'Manicure', value: 0.5, color: 'bg-emerald-100 text-emerald-700' },
            { name: 'Pedicure', value: 1.0, color: 'bg-blue-100 text-blue-700' },
            { name: 'Acrylics/Full', value: 1.5, color: 'bg-amber-100 text-amber-700' },
            { name: 'Fills', value: 1.0, color: 'bg-blue-100 text-blue-700' },
            { name: 'Waxing', value: 0.5, color: 'bg-emerald-100 text-emerald-700' },
            { name: 'Requested (per svc)', value: 0.5, color: 'bg-pink-100 text-pink-700' },
          ].map((s) => (
            <div key={s.name} className="flex items-center justify-between p-3 rounded-xl bg-gray-50">
              <span className="font-mono text-xs text-gray-700">{s.name}</span>
              <span className={`px-2 py-0.5 rounded-full font-mono text-[10px] font-bold ${s.color}`}>
                {s.value}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
