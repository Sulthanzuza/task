import { useEffect, useRef, useState } from 'react';
import { File as FileIcon, FileSpreadsheet, FileText, Pencil, X } from 'lucide-react';
import { attachmentDescriptionSchema } from '@tm/shared';
import { Button, Card, FieldError, Label, Spinner, Textarea } from '@/components/ui/primitives';
import {
  isPreparableImage,
  prepareImageForUpload,
  renderPdfFirstPage,
  MAX_IMAGE_SIDE,
} from '@/lib/imagePrep';
import { cn, formatSize } from '@/lib/utils';
import { ImageMarkup } from './ImageMarkup';

/**
 * What is about to be attached, before it is attached.
 *
 * Files used to go up the moment they were chosen, which meant a wrong file
 * was discovered only once it was on the task and had to be deleted again.
 * Now everything waits here: the picture is shown, a PDF's first page is
 * rendered, and each file carries the sentence saying what it is for.
 *
 * Images are also processed on the way in — turned the right way up, stripped
 * of their metadata and brought down to a sane size — so what is previewed is
 * exactly what will be uploaded, not an approximation of it.
 */

export interface PendingFile {
  id: string;
  /** What will actually be uploaded. Replaced by the markup editor. */
  file: File;
  /** The file as chosen, kept so "Edit" always starts from the original. */
  original: File;
  description: string;
  previewUrl: string | null;
  pageCount: number | null;
  /** True once the markup editor has saved over it. */
  edited: boolean;
  /** Set when preparing failed; the file can still be uploaded as it is. */
  warning: string | null;
  busy: boolean;
}

let sequence = 0;
const nextId = () => 'pending-' + String((sequence += 1));

function DocumentIcon({ type }: { type: string }) {
  const Icon =
    type.includes('sheet') || type.includes('excel') || type === 'text/csv'
      ? FileSpreadsheet
      : type.startsWith('text/') || type.includes('word') || type === 'application/pdf'
        ? FileText
        : FileIcon;

  return <Icon size={34} className="text-ink-faint" aria-hidden />;
}

/**
 * Turns chosen files into previewable ones.
 *
 * Images are prepared; PDFs get their first page drawn; everything else keeps
 * its icon. A failure here is reported on the file rather than thrown, because
 * a PDF this build of pdf.js cannot parse is still a PDF worth attaching.
 */
async function describe(file: File): Promise<PendingFile> {
  const base: PendingFile = {
    id: nextId(),
    file,
    original: file,
    description: '',
    previewUrl: null,
    pageCount: null,
    edited: false,
    warning: null,
    busy: false,
  };

  try {
    if (isPreparableImage(file.type)) {
      const prepared = await prepareImageForUpload(file);
      return { ...base, file: prepared.file, previewUrl: prepared.previewUrl };
    }
    if (file.type === 'image/svg+xml') {
      return { ...base, previewUrl: URL.createObjectURL(file) };
    }
    if (file.type === 'application/pdf') {
      const preview = await renderPdfFirstPage(file);
      return { ...base, previewUrl: preview.previewUrl, pageCount: preview.pageCount };
    }
  } catch (cause) {
    /*
     * The reason is kept rather than swallowed. "It could not be previewed"
     * leaves both the person looking at it and whoever has to fix it with
     * nothing to go on.
     */
    const reason = cause instanceof Error ? cause.message : String(cause);
    return {
      ...base,
      warning: 'This one could not be previewed (' + reason + '). It can still be attached.',
    };
  }

  return base;
}

export function AttachmentPreview({
  files,
  busy,
  progress,
  error,
  onCancel,
  onUpload,
}: {
  /** The files as chosen or dropped. */
  files: File[];
  busy: boolean;
  /** 0 to 1 while uploading, or null. */
  progress: number | null;
  error: string | null;
  onCancel: () => void;
  onUpload: (ready: Array<{ file: File; description: string; edited: boolean }>) => void;
}) {
  const [pending, setPending] = useState<PendingFile[] | null>(null);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<PendingFile | null>(null);
  const [touched, setTouched] = useState(false);

  // Object URLs are revoked on the way out, or a long session leaks every
  // preview it ever drew.
  const urls = useRef<string[]>([]);
  const remember = (url: string | null) => {
    if (url) urls.current.push(url);
    return url;
  };

  useEffect(() => {
    let live = true;

    void (async () => {
      const described = await Promise.all(files.map(describe));
      if (!live) {
        described.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
        return;
      }
      described.forEach((item) => remember(item.previewUrl));
      setPending(described);
      setSelected(0);
    })();

    return () => {
      live = false;
    };
  }, [files]);

  useEffect(() => {
    const live = urls.current;
    return () => {
      /*
       * After the frame, not during it. React has removed the img elements by
       * then; revoking while they were still in the document left them
       * pointing at a URL that had gone, which Chromium logs as
       * ERR_FILE_NOT_FOUND.
       */
      const going = [...live];
      setTimeout(() => going.forEach((url) => URL.revokeObjectURL(url)), 0);
      urls.current = [];
    };
  }, []);

  /*
   * Escape cancels, as on every other dialog. Not while uploading: by then
   * some of the files may already be on the task, and closing would hide
   * which ones.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || busy || editing) return;
      event.preventDefault();
      onCancel();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, editing, onCancel]);

  const items = pending ?? [];
  const current = items[selected];

  const missing = items.filter(
    (item) => !attachmentDescriptionSchema.safeParse(item.description).success,
  );
  const ready = items.length > 0 && missing.length === 0;

  function update(id: string, change: Partial<PendingFile>) {
    setPending(
      (all) => all?.map((item) => (item.id === id ? { ...item, ...change } : item)) ?? all,
    );
  }

  function removeOne(id: string) {
    setPending((all) => {
      const left = (all ?? []).filter((item) => item.id !== id);
      setSelected((at) => Math.max(0, Math.min(at, left.length - 1)));
      return left;
    });
  }

  function send() {
    setTouched(true);
    if (!ready) return;
    onUpload(
      items.map((item) => ({
        file: item.file,
        description: item.description.trim(),
        edited: item.edited,
      })),
    );
  }

  if (editing) {
    return (
      <ImageMarkup
        // Always from the original, so editing twice is not editing the edit.
        file={editing.original}
        onCancel={() => setEditing(null)}
        onSave={(edited) => {
          const url = remember(URL.createObjectURL(edited));
          update(editing.id, { file: edited, previewUrl: url, edited: true });
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="attachment-preview-title"
        className="flex max-h-full w-full max-w-2xl flex-col gap-3 p-4"
      >
        <h2 id="attachment-preview-title" className="text-sm font-semibold">
          {items.length === 1 ? 'Attach this file?' : 'Attach these ' + items.length + ' files?'}
        </h2>

        {pending === null ? (
          <p className="py-10 text-center text-sm text-ink-faint">
            <Spinner /> Opening…
          </p>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-ink-faint">Nothing left to attach.</p>
        ) : (
          <>
            {/* The strip, when there is more than one. */}
            {items.length > 1 ? (
              <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Files to attach">
                {items.map((item, index) => (
                  <li key={item.id} className="relative shrink-0">
                    <button
                      type="button"
                      aria-label={'Show ' + item.file.name}
                      aria-current={index === selected}
                      onClick={() => setSelected(index)}
                      className={cn(
                        'flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                        index === selected ? 'border-accent' : 'border-border-subtle',
                      )}
                    >
                      {item.previewUrl ? (
                        <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <DocumentIcon type={item.file.type} />
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={'Remove ' + item.file.name}
                      onClick={() => removeOne(item.id)}
                      className="absolute -top-1.5 -right-1.5 rounded-full bg-surface p-0.5 text-ink-muted shadow hover:text-danger focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none"
                    >
                      <X size={12} aria-hidden />
                    </button>
                    {!attachmentDescriptionSchema.safeParse(item.description).success && touched ? (
                      <span
                        aria-hidden
                        className="absolute -bottom-1 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-danger"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {current ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                {/* The picture, fitted. */}
                <div className="flex min-h-40 items-center justify-center rounded-lg bg-canvas p-2">
                  {current.previewUrl ? (
                    <img
                      src={current.previewUrl}
                      alt={'Preview of ' + current.file.name}
                      className="max-h-[42vh] max-w-full rounded object-contain"
                    />
                  ) : (
                    <div className="flex flex-col items-center gap-2 py-6">
                      <DocumentIcon type={current.file.type} />
                      <p className="text-xs text-ink-faint">No preview for this kind of file.</p>
                    </div>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {current.file.name}
                  </span>
                  <span className="shrink-0">{formatSize(current.file.size)}</span>
                  {current.pageCount !== null ? (
                    <span className="shrink-0">
                      {current.pageCount} {current.pageCount === 1 ? 'page' : 'pages'}
                    </span>
                  ) : null}
                  {current.edited ? (
                    <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 font-medium text-accent">
                      Edited
                    </span>
                  ) : null}

                  {isPreparableImage(current.original.type) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditing(current)}
                      disabled={busy}
                    >
                      <Pencil size={12} aria-hidden /> Edit
                    </Button>
                  ) : null}
                </div>

                {current.warning ? (
                  <p className="mt-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                    {current.warning}
                  </p>
                ) : null}

                <div className="mt-3">
                  <Label htmlFor={'description-' + current.id}>What is this file for?</Label>
                  <Textarea
                    id={'description-' + current.id}
                    value={current.description}
                    autoFocus
                    rows={2}
                    className="min-h-0"
                    placeholder="The signed-off spec, the screenshot of the error, the export the client sent"
                    aria-invalid={
                      touched && !attachmentDescriptionSchema.safeParse(current.description).success
                        ? true
                        : undefined
                    }
                    onChange={(event) =>
                      update(current.id, { description: event.currentTarget.value })
                    }
                  />
                  <FieldError
                    message={
                      touched && !attachmentDescriptionSchema.safeParse(current.description).success
                        ? 'Say what this file is for.'
                        : undefined
                    }
                  />
                </div>
              </div>
            ) : null}
          </>
        )}

        {items.some((item) => isPreparableImage(item.original.type)) ? (
          <p className="text-xs text-ink-faint">
            Images are turned the right way up, stripped of camera and location data, and brought
            down to {MAX_IMAGE_SIDE}px on the longest side.
          </p>
        ) : null}

        {touched && missing.length > 0 ? (
          <p role="alert" className="text-xs text-danger">
            {missing.length === 1
              ? 'One file still needs a description.'
              : missing.length + ' files still need a description.'}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        ) : null}

        {progress !== null ? (
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuenow={Math.round(progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
          >
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: Math.round(progress * 100) + '%' }}
            />
          </div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={send} disabled={busy || items.length === 0}>
            {busy ? <Spinner /> : null}
            {items.length > 1 ? 'Upload (' + items.length + ')' : 'Upload'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
