import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { conflictFrom, patches, useItemMutation, useMembers, type ConflictInfo } from '../api/queries';
import { itemPriorities, type ItemAction, type ItemDetail, type ItemPriority, type TransitionAction } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { actionLabel, fromLocalInput, priorityLabel, reasonRequired, toLocalInput } from '../format';
import { useToast } from './Toasts';

interface Props {
  item: ItemDetail;
  // lets the page show the conflict banner
  onConflict: (info: ConflictInfo) => void;
}

const transitionOrder: TransitionAction[] = [
  'request_approval',
  'resolve',
  'approve',
  'reject',
  'close',
  'reopen',
  'release',
  'cancel',
];

export function ActionsPanel({ item, onConflict }: Props) {
  const { user } = useAuth();
  const toast = useToast();
  const mutation = useItemMutation(item.id);
  const allowed = new Set<ItemAction>(item.allowedActions);

  const [reasonFor, setReasonFor] = useState<TransitionAction | null>(null);
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState(false);

  const members = useMembers(allowed.has('assign') ? item.team.id : undefined);
  const busy = mutation.isPending;

  // every failure ends up here so conflicts and plain errors are treated the same way everywhere
  const handleError = (error: ApiError) => {
    const conflict = conflictFrom(error);
    if (conflict) {
      onConflict(conflict);
      return;
    }
    if (error.code === 'already_claimed') {
      toast.push('error', `Too late: ${error.message}.`);
      return;
    }
    toast.push('error', error.message);
  };

  const run = (change: Parameters<typeof mutation.mutate>[0], after?: () => void) => {
    mutation.mutate(change, { onError: handleError, onSuccess: after });
  };

  const claim = () => {
    if (!user) return;
    run({ path: `/api/items/${item.id}/claim`, optimistic: patches.claim(user) });
  };

  const transition = (action: TransitionAction, why?: string) => {
    run(
      {
        path: `/api/items/${item.id}/transitions`,
        body: { action, reason: why },
        version: item.version,
        optimistic: patches.transition(action),
      },
      () => {
        setReasonFor(null);
        setReason('');
      },
    );
  };

  const startTransition = (action: TransitionAction) => {
    if (reasonRequired.has(action)) {
      setReasonFor(action);
      setReason('');
      return;
    }
    transition(action);
  };

  const assign = (ownerId: number) => {
    const person = members.data?.find((m) => m.id === ownerId);
    if (!person) return;
    run({
      path: `/api/items/${item.id}/assign`,
      body: { ownerId },
      version: item.version,
      optimistic: patches.assign({ id: person.id, name: person.name }),
    });
  };

  const changePriority = (priority: ItemPriority) => {
    if (priority === item.priority) return;
    run({
      path: `/api/items/${item.id}/priority`,
      body: { priority },
      version: item.version,
      optimistic: patches.priority(priority),
    });
  };

  const submitReason = (event: FormEvent) => {
    event.preventDefault();
    if (reasonFor && reason.trim().length >= 3) transition(reasonFor, reason.trim());
  };

  const transitions = transitionOrder.filter((action) => allowed.has(action));
  const nothingToDo = item.allowedActions.filter((a) => a !== 'comment').length === 0;

  return (
    <section className="panel">
      <h3>Actions</h3>

      {allowed.has('claim') && (
        <button className="btn btn-primary btn-block" disabled={busy} onClick={claim}>
          Claim this item
        </button>
      )}

      {transitions.length > 0 && (
        <div className="btn-stack">
          {transitions.map((action) => (
            <button
              key={action}
              className={`btn ${action === 'approve' ? 'btn-primary' : ''} ${action === 'cancel' || action === 'reject' ? 'btn-danger' : ''}`}
              disabled={busy}
              onClick={() => startTransition(action)}
            >
              {actionLabel[action]}
            </button>
          ))}
        </div>
      )}

      {reasonFor && (
        <form className="reason" onSubmit={submitReason}>
          <label>
            Reason to {actionLabel[reasonFor].toLowerCase()}
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} autoFocus />
          </label>
          <div className="dialog-actions">
            <button type="button" className="btn btn-small" onClick={() => setReasonFor(null)}>
              Back
            </button>
            <button type="submit" className="btn btn-small btn-primary" disabled={busy || reason.trim().length < 3}>
              Confirm
            </button>
          </div>
        </form>
      )}

      {allowed.has('assign') && (
        <label className="field">
          Owner
          <select
            value={item.owner?.id ?? ''}
            disabled={busy || members.isPending}
            onChange={(e) => e.target.value && assign(Number(e.target.value))}
          >
            <option value="" disabled>
              {members.isPending ? 'Loading…' : 'Choose a person'}
            </option>
            {members.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.role})
              </option>
            ))}
          </select>
        </label>
      )}

      {allowed.has('change_priority') && (
        <label className="field">
          Priority
          <select value={item.priority} disabled={busy} onChange={(e) => changePriority(e.target.value as ItemPriority)}>
            {itemPriorities.map((p) => (
              <option key={p} value={p}>
                {priorityLabel[p]}
              </option>
            ))}
          </select>
        </label>
      )}

      {allowed.has('edit') && !editing && (
        <button className="btn btn-small" disabled={busy} onClick={() => setEditing(true)}>
          Edit details
        </button>
      )}

      {editing && (
        <EditForm
          item={item}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(input) => run(
            {
              path: `/api/items/${item.id}`,
              method: 'PATCH',
              body: input,
              version: item.version,
              optimistic: patches.details(input),
            },
            () => setEditing(false),
          )}
        />
      )}

      {nothingToDo && !editing && <p className="muted small">No actions available to you on this item right now.</p>}
    </section>
  );
}

interface EditFormProps {
  item: ItemDetail;
  busy: boolean;
  onSave: (input: { title: string; description: string; dueAt: string | null }) => void;
  onCancel: () => void;
}

// The draft lives in this form, so a version conflict never throws away what the person typed
function EditForm({ item, busy, onSave, onCancel }: EditFormProps) {
  const [title, setTitle] = useState(item.title);
  const [description, setDescription] = useState(item.description);
  const [due, setDue] = useState(toLocalInput(item.dueAt));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ title: title.trim(), description: description.trim(), dueAt: fromLocalInput(due) });
  };

  return (
    <form className="reason" onSubmit={submit}>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required />
      </label>
      <label>
        Description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={5} maxLength={10000} />
      </label>
      <label>
        Due
        <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-small btn-primary" disabled={busy || !title.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}