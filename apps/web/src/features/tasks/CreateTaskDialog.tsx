import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { UserSummary } from '@tm/shared';
import type { z } from 'zod';
import { Paperclip, Plus, Search, Upload, Users, X } from 'lucide-react';
import {
  createTaskSchema,
  PRIORITY_LABELS,
  PRIORITY_ORDER,
  priorityColor,
  tintedPill,
  type CreateTaskInput,
  type Label as TaskLabel,
  type TaskSummary,
} from '@tm/shared';
import { useCreateTask, useTaskList } from './api';
import { useUploadAttachment } from './attachmentsApi';
import { AttachmentPreview } from './AttachmentPreview';
import { useAutoGrow } from '@/lib/useAutoGrow';
import { attachmentDescriptionSchema } from '@tm/shared';
import { useCreateLabel } from './labelsApi';
import { useLabels, useProjects, useUsers } from '@/features/team/api';
import { Markdown } from '@/components/common/Markdown';
import { LabelChip } from '@/components/common/badges';
import { ApiError } from '@/lib/api';
import {
  Button,
  Card,
  FieldError,
  Input,
  Label,
  Spinner,
  Textarea,
} from '@/components/ui/primitives';
import { PriorityIcon } from '@/components/common/badges';
import { cn } from '@/lib/utils';
import { PeoplePicker, PersonPicker } from './PersonPicker';
import { OptionPicker } from '@/components/ui/OptionPicker';

/**
 * Uses the same Zod schema the API validates with, so the two agree by construction.
 *
 * The form is typed on the schema's INPUT side: fields with a default are optional
 * while someone is still filling the form, and only become required once Zod has
 * parsed it. CreateTaskInput is the parsed, output shape.
 */
type CreateTaskForm = z.input<typeof createTaskSchema>;

/**
 * The form only exists while the drawer is open, so closing it throws the draft
 * away and reopening starts clean. That is cheaper and more predictable than
 * resetting state from an effect.
 */
/** The form holds ids; the picker shows people. */
function byId(people: UserSummary[] | undefined, id: string | null | undefined) {
  if (!id) return null;
  return people?.find((person) => person.id === id) ?? null;
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  defaultProjectId,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  defaultProjectId?: string;
}) {
  if (!open) return null;
  return <CreateTaskForm onOpenChange={onOpenChange} defaultProjectId={defaultProjectId} />;
}

function CreateTaskForm({
  onOpenChange,
  defaultProjectId,
}: {
  onOpenChange(open: boolean): void;
  defaultProjectId?: string;
}) {
  const navigate = useNavigate();
  const projects = useProjects();
  const people = useUsers();

  // Null means "not chosen yet", so the first project the user can see can act as
  // the default without an effect writing it into state.
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(defaultProjectId ?? null);
  const [formError, setFormError] = useState<string | null>(null);

  const projectId = chosenProjectId ?? projects.data?.items[0]?.id ?? '';
  const create = useCreateTask(projectId);

  const [description, setDescription] = useState('');
  const [preview, setPreview] = useState(false);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  // Five lines up to 40% of the window, the same rule as the comment box.
  useAutoGrow(descriptionRef, preview ? '' : description, 5);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dependsOn, setDependsOn] = useState<TaskSummary[]>([]);
  const [files, setFiles] = useState<QueuedFile[]>([]);
  // Set on the first attempt to create with an undescribed file, so the
  // boxes are only pointed at once somebody has tried to skip them.
  const [queueChecked, setQueueChecked] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);

  /*
   * An untouched <input> gives '', which is not a uuid, not a date and not a
   * number. Left as it is, the resolver refuses the form with "Must be a date
   * like 2026-09-28" against a field nobody filled in, so empty means absent
   * here, before validation rather than after it.
   */
  const optional = { setValueAs: (value: unknown) => (value === '' ? null : value) };

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<CreateTaskForm>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: {
      title: '',
      priority: 'MEDIUM',
      labelIds: [],
      dependsOnTaskIds: [],
      assigneeIds: [],
    },
  });

  /*
   * useWatch rather than watch(): watch returns a fresh function on every
   * render, which the React Compiler cannot memoize, so it gives up on the
   * whole component.
   */
  const priority = useWatch({ control, name: 'priority' });
  const assigneeIds = useWatch({ control, name: 'assigneeIds' }) ?? [];
  const reviewerId = useWatch({ control, name: 'reviewerId' });

  // The task must exist before anything can be attached to it, so the upload
  // hook is bound once the key is known.
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const upload = useUploadAttachment(createdKey ?? undefined);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);

    // Each queued file needs its reason before the task exists, since the
    // uploads start the moment it does.
    if (files.some((queued) => !describedQueuedFile(queued))) {
      setQueueChecked(true);
      setFormError('Say what each attached file is for.');
      return;
    }

    try {
      // The resolver has already parsed and defaulted these values.
      const task = await create.mutateAsync({
        ...(values as CreateTaskInput),
        description: description.trim() || undefined,
        labelIds,
        dependsOnTaskIds: dependsOn.map((task) => task.id),
      });

      setCreatedKey(task.key);

      /*
       * Attachments go up after the task exists, because an attachment needs a
       * task to belong to. A file that will not upload must not lose the task
       * that was just created, so a failure here is reported against the file
       * and the task is still opened.
       */
      const failed: string[] = [];
      for (const { file, description, edited } of files) {
        setUploading(file.name);
        try {
          await upload.mutateAsync({
            file,
            description: description.trim(),
            edited,
            onProgress: () => undefined,
          });
        } catch {
          failed.push(file.name);
        }
      }
      setUploading(null);

      onOpenChange(false);
      navigate('/tasks/' + task.key, {
        state: failed.length > 0 ? { attachmentsFailed: failed } : undefined,
      });
    } catch (error) {
      if (error instanceof ApiError) {
        // Put server-side field errors next to the inputs that caused them.
        const fields = error.fieldErrors();
        let placed = false;
        for (const [path, message] of Object.entries(fields)) {
          setError(path as keyof CreateTaskForm, { message });
          placed = true;
        }
        if (!placed) setFormError(error.message);
      } else {
        setFormError('Could not create the task.');
      }
    }
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      {/* A drawer rather than a box: there is enough here to need the height. */}
      <Card className="h-full w-full max-w-xl overflow-y-auto rounded-none p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">New task</h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
          >
            <X size={16} />
          </Button>
        </div>

        <form onSubmit={onSubmit} noValidate className="space-y-3.5">
          <div>
            <Label>Project</Label>
            {/* The drawer's own styling, not the operating system's. */}
            <OptionPicker
              label="Project"
              value={projectId}
              onChange={setChosenProjectId}
              options={(projects.data?.items ?? []).map((project) => ({
                value: project.id,
                label: project.key + ' — ' + project.name,
              }))}
            />
          </div>

          <div>
            <Label htmlFor="title">Title</Label>
            <Input id="title" autoFocus {...register('title')} />
            <FieldError message={errors.title?.message} />
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <Label htmlFor="description" hint="markdown">
                Description
              </Label>
              <div className="flex gap-1">
                <TabButton active={!preview} onClick={() => setPreview(false)}>
                  Write
                </TabButton>
                <TabButton active={preview} onClick={() => setPreview(true)}>
                  Preview
                </TabButton>
              </div>
            </div>

            {preview ? (
              <div className="min-h-24 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-sm">
                {description.trim() ? (
                  <Markdown text={description} />
                ) : (
                  <p className="text-ink-faint">Nothing to preview yet.</p>
                )}
              </div>
            ) : (
              <Textarea
                id="description"
                ref={descriptionRef}
                rows={5}
                // Grows with what is written, like the comment box.
                className="resize-none"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={
                  'What needs doing, and how you will know it is done.\n\n- **bold**, `code`, [links](https://example.com)'
                }
              />
            )}
            <FieldError message={errors.description?.message} />
          </div>

          <LabelPicker projectId={projectId} chosen={labelIds} onChange={setLabelIds} />

          <DependencyPicker chosen={dependsOn} onChange={setDependsOn} />

          <AttachmentQueue files={files} onChange={setFiles} showErrors={queueChecked} />

          <div className="grid grid-cols-2 gap-3">
            {/*
              The picker rather than a select: giving work out is a question
              about who has room, and the open count answers it here instead
              of on the dashboard.
            */}
            <div>
              <Label>Assignee</Label>
              <PeoplePicker
                label="Assignee"
                value={assigneeIds}
                onChange={(ids) => setValue('assigneeIds', ids)}
              />
              {/*
                Said plainly, before the button is pressed. Creating eight
                tasks when you meant one is not something to discover
                afterwards.
              */}
              {assigneeIds.length > 1 ? (
                <p className="mt-1.5 flex items-center gap-1.5 text-xs text-accent">
                  <Users size={12} aria-hidden />
                  Each person gets their own task (group task)
                </p>
              ) : null}
            </div>

            <div>
              <Label>Reviewer</Label>
              <PersonPicker
                label="Reviewer"
                nobodyLabel="Nobody yet"
                value={byId(people.data?.items, reviewerId)}
                onChange={(id) => setValue('reviewerId', id)}
              />
            </div>

            {/*
              Full width, because four labelled segments do not fit half of
              a drawer: "Low" was clipped to a letter and a half. Below
              420px they wrap to two rows rather than shrinking further.
            */}
            <div className="col-span-2">
              <Label>Priority</Label>
              {/*
                Four choices, all of them short, and the one that matters is
                picked by eye on its colour. A dropdown hides three of them
                behind a click for no gain.
              */}
              <div
                role="radiogroup"
                aria-label="Priority"
                /*
                 * The track is the card colour, not surface-muted. A tinted
                 * pill on a tinted surface stacks two tints, and the text
                 * loses the contrast the tokens were tuned to give it on a
                 * card: axe measured 4.42:1 on the one that was.
                 */
                className="grid grid-cols-2 gap-1 rounded-[var(--radius-input)] border border-border-subtle bg-surface p-1 min-[420px]:grid-cols-4"
              >
                {PRIORITY_ORDER.map((option) => {
                  const active = priority === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setValue('priority', option)}
                      style={active ? tintedPill(priorityColor(option)) : undefined}
                      className={cn(
                        'flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
                        active ? 'border' : 'border-transparent text-ink-muted hover:text-ink',
                      )}
                    >
                      <PriorityIcon priority={option} size={12} />
                      {PRIORITY_LABELS[option]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <Label htmlFor="estimatedHours">Estimate (hours)</Label>
              <Input
                id="estimatedHours"
                type="number"
                min={0}
                step={0.5}
                {...register('estimatedHours', optional)}
              />
              <FieldError message={errors.estimatedHours?.message} />
            </div>

            <div>
              <Label htmlFor="startDate">Start</Label>
              <Input id="startDate" type="date" {...register('startDate', optional)} />
            </div>

            <div>
              <Label htmlFor="dueDate">Due</Label>
              <Input id="dueDate" type="date" {...register('dueDate', optional)} />
              <FieldError message={errors.dueDate?.message} />
            </div>
          </div>

          {formError ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
            </p>
          ) : null}

          {uploading ? (
            <p className="text-xs text-ink-muted">
              <Spinner /> Attaching {uploading}…
            </p>
          ) : null}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !projectId}>
              {isSubmitting ? <Spinner /> : null}
              Create task
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'rounded-md px-2 py-0.5 text-xs',
        active ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-surface-muted',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Labels, picked or made on the spot.
 *
 * Making somebody leave the form to create a label is how projects end up with
 * "urgent", "Urgent" and "urgnet", so a name that does not exist yet can be
 * added from here.
 */
function LabelPicker({
  projectId,
  chosen,
  onChange,
}: {
  projectId: string;
  chosen: string[];
  onChange(next: string[]): void;
}) {
  const labels = useLabels(projectId);
  const createLabel = useCreateLabel(projectId);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const all = labels.data?.items ?? [];
  const picked = all.filter((label) => chosen.includes(label.id));

  const matches = all.filter(
    (label) =>
      !chosen.includes(label.id) && label.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const exact = all.some((label) => label.name.toLowerCase() === query.trim().toLowerCase());

  async function add(label: TaskLabel) {
    onChange([...chosen, label.id]);
    setQuery('');
  }

  return (
    <div>
      <Label htmlFor="label-search">Labels</Label>

      {picked.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {picked.map((label) => (
            <span key={label.id} className="inline-flex items-center gap-1">
              <LabelChip name={label.name} color={label.color} />
              <button
                type="button"
                aria-label={'Remove ' + label.name}
                className="text-ink-faint hover:text-danger"
                onClick={() => onChange(chosen.filter((id) => id !== label.id))}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <Input
        id="label-search"
        value={query}
        placeholder="Find a label, or type a new name"
        onChange={(event) => {
          setQuery(event.target.value);
          setError(null);
        }}
      />

      {query.trim() !== '' ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {matches.slice(0, 6).map((label) => (
            <button key={label.id} type="button" onClick={() => void add(label)}>
              <LabelChip name={label.name} color={label.color} />
            </button>
          ))}

          {!exact ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={createLabel.isPending}
              onClick={async () => {
                try {
                  const created = await createLabel.mutateAsync(query.trim());
                  await add(created);
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'That label was not created.');
                }
              }}
            >
              <Plus size={13} aria-hidden /> Create “{query.trim()}”
            </Button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What this task is waiting on, searched by key.
 *
 * A new task cannot depend on itself and cannot be part of a cycle, since it
 * does not exist yet; the server still checks both, and says so plainly if a
 * later edit would create one.
 */
function DependencyPicker({
  chosen,
  onChange,
}: {
  chosen: TaskSummary[];
  onChange(next: TaskSummary[]): void;
}) {
  const [query, setQuery] = useState('');
  const search = useTaskList(query.trim().length >= 2 ? { q: query.trim(), limit: 8 } : {});

  const results = (query.trim().length >= 2 ? (search.data?.pages[0]?.items ?? []) : []).filter(
    (task) => !chosen.some((picked) => picked.id === task.id),
  );

  return (
    <div>
      <Label htmlFor="dependency-search" hint="this task cannot start until they are done">
        Waiting on
      </Label>

      {chosen.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {chosen.map((task) => (
            <li key={task.id} className="flex items-center gap-2 text-sm">
              <span className="font-mono text-xs text-accent">{task.key}</span>
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <button
                type="button"
                aria-label={'Remove ' + task.key}
                className="text-ink-faint hover:text-danger"
                onClick={() => onChange(chosen.filter((picked) => picked.id !== task.id))}
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <Input
          id="dependency-search"
          className="pl-9"
          value={query}
          placeholder="Search by key or title, e.g. ERP-125"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {results.length > 0 ? (
        <ul className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-border-subtle">
          {results.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-muted"
                onClick={() => {
                  onChange([...chosen, task]);
                  setQuery('');
                }}
              >
                <span className="font-mono text-xs text-accent">{task.key}</span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** A file chosen on the form, and the reason it is being attached. */
interface QueuedFile {
  file: File;
  description: string;
  /** Went through the markup editor in the preview. */
  edited: boolean;
}

function describedQueuedFile(queued: QueuedFile): boolean {
  return attachmentDescriptionSchema.safeParse(queued.description).success;
}

/** Files chosen now, uploaded once the task exists. Each one says what it is for. */
function AttachmentQueue({
  files,
  onChange,
  showErrors,
}: {
  files: QueuedFile[];
  onChange(next: QueuedFile[]): void;
  showErrors: boolean;
}) {
  const [over, setOver] = useState(false);
  /*
   * Files go through the same preview as the task page, so an image chosen
   * here is turned the right way up, stripped of its metadata and open to
   * markup exactly as it would be there. Two paths would mean one of them
   * quietly keeping the GPS.
   */
  const [choosing, setChoosing] = useState<File[] | null>(null);

  return (
    <div>
      <Label htmlFor="new-task-files">Attachments</Label>

      {files.length > 0 ? (
        <ul className="mb-2 space-y-2">
          {files.map((queued) => {
            const { file } = queued;
            const missing = showErrors && !describedQueuedFile(queued);
            return (
              <li key={file.name + file.size} className="text-sm">
                <div className="flex items-center gap-2">
                  <Paperclip size={13} className="shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={'Remove ' + file.name}
                    className="text-ink-faint hover:text-danger"
                    onClick={() => onChange(files.filter((candidate) => candidate !== queued))}
                  >
                    <X size={13} />
                  </button>
                </div>
                <Input
                  className="mt-1 h-9"
                  value={queued.description}
                  placeholder="What is this file for?"
                  aria-label={'What ' + file.name + ' is for'}
                  aria-invalid={missing ? true : undefined}
                  onChange={(event) =>
                    onChange(
                      files.map((candidate) =>
                        candidate === queued
                          ? { ...candidate, description: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
                <FieldError message={missing ? 'Say what this file is for.' : undefined} />
              </li>
            );
          })}
        </ul>
      ) : null}

      {/*
        The same drop zone as the task page, rather than the browser's own
        "Choose File" button, which is the one control on this form that
        looks like a different application.
      */}
      <label
        htmlFor="new-task-files"
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const dropped = Array.from(event.dataTransfer.files);
          if (dropped.length > 0) setChoosing(dropped);
        }}
        className={cn(
          'flex cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left transition-colors',
          over ? 'border-accent bg-accent-soft' : 'border-border-subtle hover:border-border-strong',
        )}
      >
        <Upload size={14} aria-hidden className={over ? 'text-accent' : 'text-ink-faint'} />
        <span className="text-xs text-ink-faint">
          Drop files here, or choose them. Uploaded once the task has been created.
        </span>
      </label>

      <input
        id="new-task-files"
        type="file"
        multiple
        className="sr-only"
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? []);
          if (chosen.length > 0) setChoosing(chosen);
          event.target.value = '';
        }}
      />

      {choosing ? (
        <AttachmentPreview
          files={choosing}
          busy={false}
          progress={null}
          error={null}
          onCancel={() => setChoosing(null)}
          onUpload={(ready) => {
            onChange([...files, ...ready]);
            setChoosing(null);
          }}
        />
      ) : null}
    </div>
  );
}
