import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Upload } from 'lucide-react';
import {
  useImportColumns,
  useImportCommit,
  useImportPreview,
  type ImportCommitResult,
  type ImportPreviewResult,
  type ImportRowProblem,
} from './api';
import { AdminPage, Banner, useBanner } from './shared';
import { ConfirmDialog, useConfirm } from '@/components/ui/ConfirmDialog';
import { Button, Card, EmptyState, Skeleton } from '@/components/ui/primitives';

/**
 * Bringing an existing task list in.
 *
 * The dry run always happens first and writes nothing. Import stays disabled
 * while any row has a problem, because the server refuses a file with even one
 * bad row: half an import is worse than none, and much harder to undo.
 */

const COLUMN_ORDER = [
  'title',
  'project key',
  'assignee email',
  'priority',
  'status',
  'due date',
  'estimate hours',
] as const;

export function ImportPage() {
  const columns = useImportColumns();
  const preview = useImportPreview();
  const commit = useImportCommit();
  const banner = useBanner();

  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportPreviewResult | null>(null);
  const [committed, setCommitted] = useState<ImportCommitResult | null>(null);

  const confirmImport = useConfirm<File>();

  const problemsByRow = new Map<number, ImportRowProblem[]>();
  for (const problem of result?.problems ?? []) {
    const list = problemsByRow.get(problem.rowNumber) ?? [];
    list.push(problem);
    problemsByRow.set(problem.rowNumber, list);
  }

  const canImport = result !== null && result.problems.length === 0 && result.ready.length > 0;

  async function runPreview(chosen: File) {
    setFile(chosen);
    setCommitted(null);
    setResult(null);
    banner.clear();
    try {
      setResult(await preview.mutateAsync(chosen));
    } catch (error) {
      banner.show('error', error instanceof Error ? error.message : 'That file could not be read.');
    }
  }

  return (
    <AdminPage
      title="Import"
      description="Bring an existing task list in from a spreadsheet. Nothing is written until you have seen what would happen."
      action={
        <Button variant="outline" onClick={() => downloadTemplate(columns.data?.columns)}>
          <Download size={15} aria-hidden /> Download the template
        </Button>
      }
    >
      <Banner {...banner.props} />

      <Card className="p-4">
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border-subtle px-4 py-8 text-center"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const dropped = event.dataTransfer.files[0];
            if (dropped) void runPreview(dropped);
          }}
        >
          <Upload size={22} className="text-ink-faint" aria-hidden />
          <p className="text-sm text-ink-muted">
            Drop a CSV or XLSX here, or choose one.
            {file ? <span className="mt-1 block text-ink">{file.name}</span> : null}
          </p>

          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,text/csv"
            className="sr-only"
            aria-label="Choose a spreadsheet"
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              if (chosen) void runPreview(chosen);
            }}
          />
          <Button variant="outline" onClick={() => inputRef.current?.click()}>
            Choose a file
          </Button>
        </div>
      </Card>

      {preview.isPending ? <Skeleton className="h-48 w-full" /> : null}

      {result ? (
        <>
          <Card className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">
                  {result.totalRows} {result.totalRows === 1 ? 'row' : 'rows'} read
                </h2>
                <p className="mt-0.5 text-sm text-ink-muted">
                  {result.problems.length === 0
                    ? result.ready.length + ' would be created. Nothing has been written yet.'
                    : 'Fix ' +
                      problemsByRow.size +
                      (problemsByRow.size === 1 ? ' row' : ' rows') +
                      ' before importing. A file with any bad row is refused whole.'}
                </p>
              </div>

              <Button
                disabled={!canImport || commit.isPending}
                onClick={() => {
                  if (file) confirmImport.ask(file);
                }}
              >
                Import {result.ready.length} {result.ready.length === 1 ? 'task' : 'tasks'}
              </Button>
            </div>
          </Card>

          <Card className="relative overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">What the file would create</caption>
              <thead>
                <tr className="border-b border-border-subtle text-left text-xs text-ink-faint">
                  <th scope="col" className="px-3 py-2 font-medium">
                    Row
                  </th>
                  {COLUMN_ORDER.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className="px-3 py-2 font-medium whitespace-nowrap"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {result.ready.map((row) => (
                  <tr key={row.rowNumber}>
                    <td className="px-3 py-2 text-xs text-ink-faint">{row.rowNumber}</td>
                    <Cell value={row.title} />
                    <Cell value={row.projectKey} mono />
                    <Cell value={row.assigneeEmail} />
                    <Cell value={row.priority} />
                    <Cell value={row.status} />
                    <Cell value={row.dueDate} mono />
                    <Cell value={row.estimateHours === null ? null : String(row.estimateHours)} />
                  </tr>
                ))}

                {[...problemsByRow.entries()]
                  .sort((a, b) => a[0] - b[0])
                  .map(([rowNumber, problems]) => (
                    <tr key={'bad-' + rowNumber} className="bg-danger-soft/50">
                      <td className="px-3 py-2 text-xs font-medium text-danger">{rowNumber}</td>
                      <td className="px-3 py-2 text-danger" colSpan={COLUMN_ORDER.length}>
                        <ul className="space-y-0.5">
                          {problems.map((problem) => (
                            <li key={problem.column + problem.message} className="text-xs">
                              <span className="font-medium">{problem.column}</span>:{' '}
                              {problem.message}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>
        </>
      ) : null}

      {committed ? (
        <Card className="p-4">
          <h2 className="text-sm font-semibold">
            {committed.created.length} {committed.created.length === 1 ? 'task' : 'tasks'} created
          </h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {committed.created.map((created) => (
              <li key={created.taskKey}>
                <Link
                  to={'/tasks/' + created.taskKey}
                  className="rounded-md bg-surface-muted px-2 py-1 font-mono text-xs text-accent hover:underline"
                >
                  {created.taskKey}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {!result && !preview.isPending ? (
        <Card>
          <EmptyState
            title="Nothing to show yet"
            description="Choose a file to see exactly what it would create, row by row."
          />
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmImport.open}
        title={'Create ' + (result?.ready.length ?? 0) + ' tasks?'}
        description="Each one is created as though a lead had typed it, with its history starting now. There is no undo, so tasks created by mistake have to be cancelled one at a time."
        confirmLabel="Import"
        tone="primary"
        busy={confirmImport.busy}
        error={confirmImport.error}
        onCancel={confirmImport.cancel}
        onConfirm={() => {
          void confirmImport.run(async (chosen) => {
            const done = await commit.mutateAsync(chosen);
            setCommitted(done);
            setResult(null);
            setFile(null);
            banner.show(
              'success',
              done.created.length + ' tasks were created from ' + chosen.name + '.',
            );
          });
        }}
      />
    </AdminPage>
  );
}

function Cell({ value, mono }: { value: string | null; mono?: boolean }) {
  return (
    <td className={'px-3 py-2 ' + (mono ? 'font-mono text-xs' : '')}>
      {value ?? <span className="text-ink-faint">—</span>}
    </td>
  );
}

/**
 * A template with one example row, because a bare header leaves the operator
 * guessing what a date or a priority should look like.
 */
function downloadTemplate(columns: string[] | undefined): void {
  const header = columns ?? [...COLUMN_ORDER];
  const example = [
    'Rewrite the invoice export',
    'ERP',
    'someone@example.com',
    'HIGH',
    'TODO',
    new Date().toISOString().slice(0, 10),
    '8',
  ];

  const csv = [header, example]
    .map((row) =>
      row
        .map((cell) => (/[",\n]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell))
        .join(','),
    )
    .join('\r\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = 'task-import-template.csv';
  link.click();

  URL.revokeObjectURL(url);
}
