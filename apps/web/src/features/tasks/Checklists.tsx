import { useState } from 'react';
import { ChevronDown, ChevronUp, ListChecks, Plus, Trash2, X } from 'lucide-react';
import type { Checklist, TaskDetail } from '@tm/shared';
import { progressFromChecklists } from '@tm/shared';
import {
  useAddChecklist,
  useAddChecklistItem,
  useChecklists,
  useDeleteChecklist,
  useDeleteChecklistItem,
  useProgressSource,
  useRenameChecklist,
  useReorderChecklists,
  useReorderChecklistItems,
  useUpdateChecklistItem,
} from './checklistsApi';
import { ConfirmDialog, useConfirm } from '@/components/ui/ConfirmDialog';
import { Button, Card, CardHeader, Input, Spinner } from '@/components/ui/primitives';
import { useAuth } from '@/features/auth/AuthContext';
import { cn, formatDateTime } from '@/lib/utils';

/**
 * Checklists on a task.
 *
 * Several per task, each with a title, because "Build", "Test" and "Deploy"
 * each have their own steps and their own sense of being finished. One list
 * is the ordinary case and reads as one list.
 *
 * Two permissions, which is the part worth knowing: a lead decides what the
 * steps *are*, and the person doing the task says which are *done*. So a
 * member sees tickboxes and no edit controls, and the tick is never somebody
 * else's to make on their behalf.
 */

export function ChecklistsCard({ task }: { task: TaskDetail }) {
  const { user, isLead } = useAuth();
  const lists = useChecklists(task.key);

  const canEditStructure = isLead;
  // The assignee reports on their own work; a lead may tick as well.
  const canTick = isLead || task.assignee?.id === user?.id;

  const add = useAddChecklist(task.key);
  const reorder = useReorderChecklists(task.key);
  const progressSource = useProgressSource(task.key);

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const data = lists.data;
  const items = data?.items ?? [];

  // Nothing to show and nothing to be done about it: say nothing at all
  // rather than spend a card on an empty state a member cannot act on.
  if (!lists.isLoading && items.length === 0 && !canEditStructure) return null;

  return (
    <Card>
      <CardHeader
        title="Checklists"
        subtitle={
          data && data.totalCount > 0
            ? data.doneCount + ' of ' + data.totalCount + ' steps done'
            : 'The steps this task breaks down into'
        }
      />

      {lists.isLoading ? (
        <p className="px-4 pb-3 text-sm text-ink-faint">
          <Spinner /> Loading…
        </p>
      ) : (
        <div className="space-y-3 px-4 pb-3">
          {items.map((list, index) => (
            <ChecklistBlock
              key={list.id}
              taskKey={task.key}
              list={list}
              canEditStructure={canEditStructure}
              canTick={canTick}
              onMove={(direction) => {
                const order = items.map((each) => each.id);
                const to = index + direction;
                if (to < 0 || to >= order.length) return;
                const moved = [...order];
                const [taken] = moved.splice(index, 1);
                moved.splice(to, 0, taken as string);
                reorder.mutate(moved);
              }}
              isFirst={index === 0}
              isLast={index === items.length - 1}
            />
          ))}

          {canEditStructure ? (
            adding ? (
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!title.trim()) return;
                  add.mutate(
                    { title: title.trim(), items: [] },
                    {
                      onSuccess: () => {
                        setTitle('');
                        setAdding(false);
                      },
                    },
                  );
                }}
              >
                <Input
                  autoFocus
                  aria-label="Checklist name"
                  placeholder="Testing"
                  value={title}
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setAdding(false);
                  }}
                />
                <Button type="submit" size="sm" disabled={!title.trim() || add.isPending}>
                  Add
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
                <Plus size={13} aria-hidden /> Add checklist
              </Button>
            )
          ) : null}

          {/*
            Progress from the ticks is a per-task decision, because a slider
            is right for work that is not a list of steps.
          */}
          {canEditStructure && items.length > 0 && data ? (
            <label className="flex items-start gap-2 pt-1 text-xs text-ink-muted">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={data.progressFollowsChecklist}
                disabled={progressSource.isPending}
                onChange={(event) => progressSource.mutate(event.currentTarget.checked)}
              />
              <span>
                Count progress from these steps
                {data.progressFollowsChecklist ? (
                  <span className="text-ink-faint">
                    {' '}
                    — now {progressFromChecklists(data.doneCount, data.totalCount)}%
                  </span>
                ) : null}
              </span>
            </label>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function ChecklistBlock({
  taskKey,
  list,
  canEditStructure,
  canTick,
  onMove,
  isFirst,
  isLast,
}: {
  taskKey: string;
  list: Checklist;
  canEditStructure: boolean;
  canTick: boolean;
  onMove(direction: -1 | 1): void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const rename = useRenameChecklist(taskKey);
  const remove = useDeleteChecklist(taskKey);
  const addItem = useAddChecklistItem(taskKey);
  const updateItem = useUpdateChecklistItem(taskKey);
  const removeItem = useDeleteChecklistItem(taskKey);
  const reorderItems = useReorderChecklistItems(taskKey);

  const deletion = useConfirm<Checklist>();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(list.title);
  const [newItem, setNewItem] = useState('');

  const percent = progressFromChecklists(list.doneCount, list.totalCount);

  return (
    <section aria-label={list.title} className="rounded-lg border border-border-subtle p-2.5">
      <div className="flex items-center gap-2">
        {renaming ? (
          <form
            className="flex flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!title.trim()) return;
              rename.mutate(
                { checklistId: list.id, title: title.trim() },
                { onSuccess: () => setRenaming(false) },
              );
            }}
          >
            <Input
              autoFocus
              aria-label={'Rename ' + list.title}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setTitle(list.title);
                  setRenaming(false);
                }
              }}
            />
            <Button type="submit" size="sm" disabled={!title.trim()}>
              Save
            </Button>
          </form>
        ) : (
          <>
            <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{list.title}</h3>
            <span className="tabular shrink-0 text-xs text-ink-muted">
              {list.doneCount}/{list.totalCount}
            </span>
          </>
        )}

        {canEditStructure && !renaming ? (
          <div className="flex shrink-0 items-center">
            <button
              type="button"
              aria-label={'Move ' + list.title + ' up'}
              disabled={isFirst}
              onClick={() => onMove(-1)}
              className="rounded p-1 text-ink-faint hover:text-ink disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <ChevronUp size={13} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={'Move ' + list.title + ' down'}
              disabled={isLast}
              onClick={() => onMove(1)}
              className="rounded p-1 text-ink-faint hover:text-ink disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <ChevronDown size={13} aria-hidden />
            </button>
            <button
              type="button"
              aria-label={'Rename ' + list.title}
              onClick={() => setRenaming(true)}
              className="rounded px-1.5 py-1 text-xs text-ink-faint hover:text-ink focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              Rename
            </button>
            <button
              type="button"
              aria-label={'Delete ' + list.title}
              onClick={() => deletion.ask(list)}
              className="rounded p-1 text-ink-faint hover:text-danger focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
            >
              <Trash2 size={13} aria-hidden />
            </button>
          </div>
        ) : null}
      </div>

      {/* A thin bar, so the state of a list reads at a glance. */}
      <div
        role="progressbar"
        aria-label={list.title + ' progress'}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div className="h-full bg-accent transition-[width]" style={{ width: percent + '%' }} />
      </div>

      <ul className="mt-2 space-y-1">
        {list.items.map((item, index) => (
          <li key={item.id} className="group flex items-start gap-2">
            <input
              type="checkbox"
              id={'item-' + item.id}
              className="mt-0.5 shrink-0"
              checked={item.isDone}
              disabled={!canTick || updateItem.isPending}
              onChange={(event) =>
                updateItem.mutate({ itemId: item.id, isDone: event.currentTarget.checked })
              }
            />
            <label
              htmlFor={'item-' + item.id}
              className={cn(
                'min-w-0 flex-1 text-sm',
                item.isDone ? 'text-ink-faint line-through' : '',
                canTick ? 'cursor-pointer' : '',
              )}
            >
              {item.text}
              {item.isDone && item.doneBy ? (
                <span className="ml-1.5 text-xs text-ink-faint">
                  {item.doneBy.name}
                  {item.doneAt ? ', ' + formatDateTime(item.doneAt) : ''}
                </span>
              ) : null}
            </label>

            {canEditStructure ? (
              <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <button
                  type="button"
                  aria-label={'Move ' + item.text + ' up'}
                  disabled={index === 0}
                  onClick={() => {
                    const order = list.items.map((each) => each.id);
                    const moved = [...order];
                    const [taken] = moved.splice(index, 1);
                    moved.splice(index - 1, 0, taken as string);
                    reorderItems.mutate({ checklistId: list.id, ids: moved });
                  }}
                  className="rounded p-0.5 text-ink-faint hover:text-ink disabled:opacity-30 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <ChevronUp size={12} aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={'Remove ' + item.text}
                  onClick={() => removeItem.mutate(item.id)}
                  className="rounded p-0.5 text-ink-faint hover:text-danger focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                >
                  <X size={12} aria-hidden />
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      {canEditStructure ? (
        <form
          className="mt-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!newItem.trim()) return;
            // The box stays, so Enter after Enter adds the next step.
            addItem.mutate(
              { checklistId: list.id, text: newItem.trim() },
              { onSuccess: () => setNewItem('') },
            );
          }}
        >
          <Input
            className="h-8 text-sm"
            aria-label={'Add a step to ' + list.title}
            placeholder="Add a step, then Enter"
            value={newItem}
            onChange={(event) => setNewItem(event.currentTarget.value)}
          />
        </form>
      ) : null}

      <ConfirmDialog
        open={deletion.open}
        title={'Delete ' + (deletion.target?.title ?? 'this checklist') + '?'}
        description={
          'That removes its ' +
          String(deletion.target?.totalCount ?? 0) +
          (deletion.target?.totalCount === 1 ? ' step' : ' steps') +
          ', for everybody, and cannot be undone.'
        }
        confirmLabel="Delete it"
        busy={deletion.busy}
        error={deletion.error}
        onCancel={deletion.cancel}
        onConfirm={() => {
          void deletion.run((each) => remove.mutateAsync(each.id));
        }}
      />
    </section>
  );
}

/** The small badge on a board card and a task-list row. */
export function ChecklistBadge({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-faint"
      title={done + ' of ' + total + ' steps done'}
    >
      <ListChecks size={12} aria-hidden />
      <span className="tabular">
        {done}/{total}
      </span>
    </span>
  );
}
