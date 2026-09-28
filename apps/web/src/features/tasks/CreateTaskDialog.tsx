import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import { createTaskSchema, TASK_PRIORITIES, PRIORITY_LABELS, type CreateTaskInput } from '@tm/shared';
import { useCreateTask } from './api';
import { useProjects, useUsers } from '@/features/team/api';
import { ApiError } from '@/lib/api';
import {
  Button,
  Card,
  FieldError,
  Input,
  Label,
  Select,
  Spinner,
  Textarea,
} from '@/components/ui/primitives';

/**
 * Uses the same Zod schema the API validates with, so the two agree by construction.
 *
 * The form is typed on the schema's INPUT side: fields with a default are optional
 * while someone is still filling the form, and only become required once Zod has
 * parsed it. CreateTaskInput is the parsed, output shape.
 */
type CreateTaskForm = z.input<typeof createTaskSchema>;

/**
 * The form only exists while the dialog is open, so closing it throws the draft
 * away and reopening starts clean. That is cheaper and more predictable than
 * resetting state from an effect.
 */
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

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateTaskForm>({
    resolver: zodResolver(createTaskSchema),
    defaultValues: { title: '', priority: 'MEDIUM', labelIds: [], dependsOnTaskIds: [] },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      // The resolver has already parsed and defaulted these values.
      const task = await create.mutateAsync({
        ...(values as CreateTaskInput),
        assigneeId: values.assigneeId || null,
        reviewerId: values.reviewerId || null,
        startDate: values.startDate || null,
        dueDate: values.dueDate || null,
      });
      onOpenChange(false);
      navigate('/tasks/' + task.key);
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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
    >
      <Card className="w-full max-w-lg p-5">
        <h2 className="mb-4 text-sm font-semibold">New task</h2>

        <form onSubmit={onSubmit} noValidate className="space-y-3.5">
          <div>
            <Label htmlFor="project">Project</Label>
            <Select
              id="project"
              value={projectId}
              onChange={(e) => setChosenProjectId(e.currentTarget.value)}
            >
              {projects.data?.items.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.key} — {project.name}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="title">Title</Label>
            <Input id="title" autoFocus {...register('title')} />
            <FieldError message={errors.title?.message} />
          </div>

          <div>
            <Label htmlFor="description" hint="markdown">
              Description
            </Label>
            <Textarea id="description" {...register('description')} />
            <FieldError message={errors.description?.message} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="assigneeId">Assignee</Label>
              <Select id="assigneeId" {...register('assigneeId')}>
                <option value="">Nobody yet</option>
                {people.data?.items.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="reviewerId">Reviewer</Label>
              <Select id="reviewerId" {...register('reviewerId')}>
                <option value="">Nobody yet</option>
                {people.data?.items.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="priority">Priority</Label>
              <Select id="priority" {...register('priority')}>
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {PRIORITY_LABELS[priority]}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label htmlFor="estimatedHours">Estimate (hours)</Label>
              <Input id="estimatedHours" type="number" min={0} step={0.5} {...register('estimatedHours')} />
              <FieldError message={errors.estimatedHours?.message} />
            </div>

            <div>
              <Label htmlFor="startDate">Start</Label>
              <Input id="startDate" type="date" {...register('startDate')} />
            </div>

            <div>
              <Label htmlFor="dueDate">Due</Label>
              <Input id="dueDate" type="date" {...register('dueDate')} />
              <FieldError message={errors.dueDate?.message} />
            </div>
          </div>

          {formError ? (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {formError}
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
