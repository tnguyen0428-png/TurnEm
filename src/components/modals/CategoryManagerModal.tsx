import { useRef, useState } from 'react';
import { ChevronUp, ChevronDown, Trash2, Lock, Plus } from 'lucide-react';
import Modal from '../shared/Modal';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useApp } from '../../state/AppContext';
import { useServiceCategories } from '../../hooks/useServiceCategories';
import { CATEGORY_PALETTE, paletteFor } from '../../constants/categoryPalette';
import { categoryNameProblem, newCategoryId } from '../../utils/serviceCategories';
import type { ServiceCategory } from '../../types';

const COLOR_KEYS = Object.keys(CATEGORY_PALETTE);
const LOCKED_TIP = 'Used by turn rules — can be recolored and reordered only';

function problemMessage(problem: 'empty' | 'duplicate' | 'locked' | null): string | null {
  if (problem === 'duplicate') return 'Name already used';
  if (problem === 'empty') return 'Name is required';
  if (problem === 'locked') return LOCKED_TIP;
  return null;
}

interface ColorPickerProps {
  value: string;
  onPick: (color: string) => void;
}

function ColorPicker({ value, onPick }: ColorPickerProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {COLOR_KEYS.map((key) => (
        <button
          key={key}
          type="button"
          title={key}
          onClick={() => onPick(key)}
          className={`w-6 h-6 rounded-full ${CATEGORY_PALETTE[key].swatch} transition-transform hover:scale-110 ${
            value === key ? 'ring-2 ring-offset-2 ring-gray-900' : ''
          }`}
        />
      ))}
    </div>
  );
}

interface CategoryRowProps {
  category: ServiceCategory;
  idx: number;
  total: number;
  serviceCount: number;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
}

function CategoryRow({ category, idx, total, serviceCount, onMove, onDelete }: CategoryRowProps) {
  const { dispatch, renameServiceCategory } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(category.name);
  const [error, setError] = useState<string | null>(null);
  const [pickingColor, setPickingColor] = useState(false);
  // Enter/Escape end the edit; the input's blur can still fire as it unmounts,
  // and must not commit (or re-commit) after that.
  const doneRef = useRef(false);

  function startEdit() {
    if (category.isLocked) return;
    setDraft(category.name);
    setError(null);
    doneRef.current = false;
    setEditing(true);
  }

  function commit() {
    if (doneRef.current) return;
    const message = problemMessage(renameServiceCategory(category.id, draft));
    if (message) { setError(message); return; }
    doneRef.current = true;
    setEditing(false);
    setError(null);
  }

  function cancel() {
    doneRef.current = true;
    setEditing(false);
    setError(null);
  }

  const deleteTip = category.isLocked
    ? LOCKED_TIP
    : serviceCount > 0
      ? `Move its ${serviceCount} service${serviceCount === 1 ? '' : 's'} to another category first`
      : 'Delete category';

  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3">
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => onMove(-1)}
            disabled={idx === 0}
            className="p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:text-gray-200 disabled:hover:bg-transparent disabled:cursor-not-allowed"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={() => onMove(1)}
            disabled={idx === total - 1}
            className="p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 disabled:text-gray-200 disabled:hover:bg-transparent disabled:cursor-not-allowed"
          >
            <ChevronDown size={14} />
          </button>
        </div>

        <button
          type="button"
          title="Change color"
          onClick={() => setPickingColor((v) => !v)}
          className={`w-7 h-7 rounded-lg flex-shrink-0 ${paletteFor(category.color).swatch} ${
            pickingColor ? 'ring-2 ring-offset-2 ring-gray-900' : ''
          }`}
        />

        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setError(null); }}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
              }}
              className={`w-full px-2 py-1 rounded-lg border font-mono text-sm text-gray-900 focus:outline-none focus:ring-2 ${
                error ? 'border-red-300 focus:ring-red-200' : 'border-gray-200 focus:ring-pink-200 focus:border-pink-300'
              }`}
            />
          ) : (
            <button
              type="button"
              onClick={startEdit}
              title={category.isLocked ? LOCKED_TIP : 'Rename'}
              className={`flex items-center gap-1.5 max-w-full text-left font-mono text-sm font-semibold text-gray-900 truncate ${
                category.isLocked ? 'cursor-default' : 'hover:text-pink-600'
              }`}
            >
              {category.isLocked && <Lock size={12} className="flex-shrink-0 text-gray-400" />}
              <span className="truncate">{category.name}</span>
            </button>
          )}
          {error && <p className="mt-1 font-mono text-[11px] text-red-500">{error}</p>}
        </div>

        <span className="font-mono text-[11px] text-gray-400 flex-shrink-0">
          {serviceCount} svc
        </span>

        {!category.isLocked && (
          <button
            type="button"
            onClick={onDelete}
            disabled={serviceCount > 0}
            title={deleteTip}
            className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:text-gray-200 disabled:hover:bg-transparent disabled:cursor-not-allowed"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {pickingColor && (
        <div className="mt-3 pl-7">
          <ColorPicker
            value={category.color}
            onPick={(color) => {
              dispatch({ type: 'UPDATE_SERVICE_CATEGORY', id: category.id, updates: { color } });
              setPickingColor(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

interface CategoryManagerModalProps {
  onClose: () => void;
}

export default function CategoryManagerModal({ onClose }: CategoryManagerModalProps) {
  const { state, dispatch } = useApp();
  const { categories } = useServiceCategories();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('gray');
  const [addError, setAddError] = useState<string | null>(null);

  const serviceCounts = new Map<string, number>();
  for (const s of state.salonServices) serviceCounts.set(s.category, (serviceCounts.get(s.category) ?? 0) + 1);

  function move(idx: number, direction: -1 | 1) {
    const ids = categories.map((c) => c.id);
    const swap = idx + direction;
    if (swap < 0 || swap >= ids.length) return;
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    dispatch({ type: 'REORDER_SERVICE_CATEGORY', ids });
  }

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const message = problemMessage(categoryNameProblem(state.serviceCategories, newName));
    if (message) { setAddError(message); return; }
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.sortOrder), -1);
    dispatch({
      type: 'ADD_SERVICE_CATEGORY',
      category: {
        id: newCategoryId(newName, state.serviceCategories),
        name: newName.trim(),
        color: newColor,
        sortOrder: maxOrder + 1,
        isLocked: false,
      },
    });
    setNewName('');
    setNewColor('gray');
    setAddError(null);
  }

  const deleting = categories.find((c) => c.id === deleteId);

  return (
    <Modal title="CATEGORIES" onClose={onClose}>
      <div className="space-y-2">
        {categories.map((c, idx) => (
          <CategoryRow
            key={c.id}
            category={c}
            idx={idx}
            total={categories.length}
            serviceCount={serviceCounts.get(c.name) ?? 0}
            onMove={(direction) => move(idx, direction)}
            onDelete={() => setDeleteId(c.id)}
          />
        ))}
      </div>

      <form onSubmit={handleAdd} className="mt-5 pt-4 border-t border-gray-100 space-y-3">
        <label className="block font-mono text-[11px] text-gray-500 font-semibold tracking-wider">
          ADD CATEGORY
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setAddError(null); }}
            placeholder="e.g. Gel X"
            className={`flex-1 min-w-0 px-4 py-2.5 rounded-xl border font-mono text-sm text-gray-900 placeholder-gray-300 focus:outline-none focus:ring-2 transition-all ${
              addError ? 'border-red-300 focus:ring-red-200' : 'border-gray-200 focus:ring-pink-200 focus:border-pink-300'
            }`}
          />
          <button
            type="submit"
            disabled={!newName.trim()}
            className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-pink-500 text-white font-mono text-sm font-semibold hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98] transition-all"
          >
            <Plus size={14} />
            ADD
          </button>
        </div>
        {addError && <p className="font-mono text-[11px] text-red-500">{addError}</p>}
        <ColorPicker value={newColor} onPick={setNewColor} />
      </form>

      {deleting && (
        <ConfirmDialog
          message={`Delete the "${deleting.name}" category?`}
          confirmLabel="DELETE"
          danger
          onConfirm={() => {
            dispatch({ type: 'DELETE_SERVICE_CATEGORY', id: deleting.id });
            setDeleteId(null);
          }}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </Modal>
  );
}
