import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useCreateItem } from '../api/queries';
import { itemKinds, itemPriorities, type ItemKind, type ItemPriority } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { fromLocalInput, kindLabel, priorityLabel } from '../format';
import { useToast } from './Toasts';

interface Props {
  onClose: () => void;
}

export function NewItemDialog({ onClose }: Props) {
  const { teams } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [teamId, setTeamId] = useState<number>(teams[0]?.teamId ?? 0);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<ItemKind>('task');
  const [priority, setPriority] = useState<ItemPriority>('medium');
  const [due, setDue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = useCreateItem(teamId);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    setError(null);

    create.mutate(
      { title: title.trim(), description: description.trim(), kind, priority, dueAt: fromLocalInput(due) },
      {
        onSuccess: (item) => {
          toast.push('success', `${item.ref} created`);
          onClose();
          navigate(`/items/${item.id}`);
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create the item'),
      },
    );
  };

  return (
    <div className="overlay" onMouseDown={onClose}>
      <form className="dialog" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} aria-label="New work item">
        <h2>New work item</h2>

        <label>
          Team
          <select value={teamId} onChange={(e) => setTeamId(Number(e.target.value))}>
            {teams.map((team) => (
              <option key={team.teamId} value={team.teamId}>
                {team.teamName}
              </option>
            ))}
          </select>
        </label>

        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required autoFocus />
        </label>

        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={10000} />
        </label>

        <div className="grid-3">
          <label>
            Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>
              {itemKinds.map((k) => (
                <option key={k} value={k}>
                  {kindLabel[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as ItemPriority)}>
              {itemPriorities.map((p) => (
                <option key={p} value={p}>
                  {priorityLabel[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Due
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
        </div>

        {(kind === 'payment' || kind === 'compliance') && (
          <p className="hint">This kind of item needs a second person to approve it before it can be resolved.</p>
        )}
        {error && <p className="form-error">{error}</p>}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending || !title.trim() || !teamId}>
            {create.isPending ? 'Creating…' : 'Create item'}
          </button>
        </div>
      </form>
    </div>
  );
}