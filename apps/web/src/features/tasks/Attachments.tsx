import { useEffect, useRef, useState } from 'react';
import {
  Download,
  File,
  FileImage,
  FileText,
  FileSpreadsheet,
  Paperclip,
  Upload,
} from 'lucide-react';
import { ALLOWED_ATTACHMENT_MIME_TYPES } from '@tm/shared';
import {
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
  type Attachment,
} from './attachmentsApi';
import { ConfirmDialog, useConfirm } from '@/components/ui/ConfirmDialog';
import { Button, Card, Spinner } from '@/components/ui/primitives';
import { useAuth } from '@/features/auth/AuthContext';
import { getAccessToken } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';

/**
 * Files on a task.
 *
 * Dropping a file is the usual way in; the button exists because dragging is
 * awkward on a phone and impossible from a keyboard. Whatever the server says
 * about a refused file is shown as it said it, since "that kind of file
 * cannot be attached" is more use than "upload failed".
 */

const MAX_UPLOAD_MB = 25;

/**
 * Whether a file is being dragged over the window.
 *
 * dragenter and dragleave fire for every element the pointer crosses, so a
 * naive listener flickers all the way across the page. Counting the pairs
 * and only clearing at zero gives one steady answer for the whole drag.
 */
function useFileDragOverPage(): boolean {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const enter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current += 1;
      setOver(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    };
    const drop = () => {
      depth.current = 0;
      setOver(false);
    };

    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    // A drag that ends outside the window never fires drop.
    window.addEventListener('dragend', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('dragend', drop);
    };
  }, []);

  return over;
}

export function Attachments({
  taskIdOrKey,
  canAttach,
  canDeleteAny,
}: {
  taskIdOrKey: string;
  canAttach: boolean;
  /** A lead may remove anybody's file; everyone else only their own. */
  canDeleteAny: boolean;
}) {
  const { user } = useAuth();
  const attachments = useAttachments(taskIdOrKey);
  const upload = useUploadAttachment(taskIdOrKey);
  const remove = useDeleteAttachment(taskIdOrKey);

  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const deletion = useConfirm<Attachment>();

  async function send(file: File) {
    setError(null);

    // Caught here as well as on the server, so a 30 MB file is not uploaded
    // in full just to be turned away at the end of it.
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(
        file.name + ' is ' + formatSize(file.size) + '. The limit is ' + MAX_UPLOAD_MB + ' MB.',
      );
      return;
    }

    setProgress(0);
    try {
      await upload.mutateAsync({ file, onProgress: setProgress });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That file was not attached.');
    } finally {
      setProgress(null);
    }
  }

  const items = attachments.data?.items ?? [];
  // A file over the window anywhere: that is when the big target earns its space.
  const fileOverPage = useFileDragOverPage();
  const expanded = dragging || fileOverPage;

  return (
    <section aria-labelledby="attachments-heading">
      <h2 id="attachments-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Paperclip size={15} aria-hidden />
        Attachments
        {items.length > 0 ? (
          <span className="font-normal text-ink-faint">{items.length}</span>
        ) : null}
      </h2>

      <Card>
        {canAttach ? (
          /*
             A line, not a landing strip.

             At rest this is one row saying what you can do, because a panel
             with nothing in it was spending five lines to say "empty". The
             full target appears the moment a file is actually over the
             window, which is the only moment it is any use.
           */
          <div
            data-testid="attachment-dropzone"
            className={cn(
              'm-3 rounded-lg border border-dashed text-center transition-all',
              expanded
                ? 'flex flex-col items-center gap-2 px-4 py-5'
                : 'flex items-center gap-2 px-3 py-2 text-left',
              dragging || fileOverPage ? 'border-accent bg-accent-soft' : 'border-border-subtle',
            )}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const dropped = event.dataTransfer.files[0];
              if (dropped) void send(dropped);
            }}
          >
            <Upload
              size={expanded ? 18 : 14}
              className={cn('shrink-0', expanded ? 'text-accent' : 'text-ink-faint')}
              aria-hidden
            />
            <p className={cn('text-xs', expanded ? 'text-ink-muted' : 'text-ink-faint')}>
              {expanded
                ? 'Drop it here. Up to ' + MAX_UPLOAD_MB + ' MB.'
                : items.length === 0
                  ? 'No files. Drop one here, or choose a file.'
                  : 'Drop another here, or choose a file.'}
            </p>

            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              aria-label="Choose a file to attach"
              accept={ALLOWED_ATTACHMENT_MIME_TYPES.join(',')}
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) void send(chosen);
                // Clear it, so choosing the same file twice still fires.
                event.target.value = '';
              }}
            />

            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              Choose a file
            </Button>
          </div>
        ) : null}

        {progress !== null ? (
          <div className="px-4 pb-3">
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
            <p className="mt-1 text-xs text-ink-faint">Uploading… {Math.round(progress * 100)}%</p>
          </div>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="mx-3 mb-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}

        {attachments.isLoading ? (
          <p className="px-4 py-3 text-sm text-ink-faint">
            <Spinner /> Loading files…
          </p>
        ) : items.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-faint">Nothing is attached to this task.</p>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {items.map((attachment) => (
              <li key={attachment.id} className="flex items-center gap-3 px-4 py-2.5">
                <Thumbnail attachment={attachment} />

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{attachment.fileName}</p>
                  <p className="truncate text-xs text-ink-faint">
                    {formatSize(attachment.sizeBytes)} · {attachment.uploadedBy.name} ·{' '}
                    {formatDateTime(attachment.createdAt)}
                  </p>
                </div>

                <a
                  href={attachment.downloadUrl}
                  download={attachment.fileName}
                  className="shrink-0 rounded-lg p-2 text-ink-muted hover:bg-surface-muted hover:text-ink"
                  aria-label={'Download ' + attachment.fileName}
                  onClick={(event) => {
                    // The bytes go through the API, so the request needs the
                    // access token that a plain link cannot carry.
                    event.preventDefault();
                    void download(attachment);
                  }}
                >
                  <Download size={15} />
                </a>

                {canDeleteAny || attachment.uploadedBy.id === user?.id ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger"
                    onClick={() => deletion.ask(attachment)}
                  >
                    Delete
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={deletion.open}
        title={'Delete ' + (deletion.target?.fileName ?? '') + '?'}
        description="The file is removed for everyone, and the deletion is recorded in the task's history. It cannot be recovered."
        confirmLabel="Delete"
        busy={deletion.busy}
        error={deletion.error}
        onCancel={deletion.cancel}
        onConfirm={() => {
          void deletion.run((attachment) => remove.mutateAsync(attachment.id));
        }}
      />
    </section>
  );
}

/** An image shows itself; everything else gets an icon that says what it is. */
function Thumbnail({ attachment }: { attachment: Attachment }) {
  const [source, setSource] = useState<string | null>(null);
  const isImage = attachment.mimeType.startsWith('image/');

  /*
   * Fetched rather than linked: the bytes go through the API so that the
   * access check applies to them, which a plain src cannot satisfy. The object
   * URL is released on the way out, or a long task page leaks one per image.
   */
  useEffect(() => {
    if (!isImage) return;

    let url: string | null = null;
    let cancelled = false;

    void fetchBlob(attachment)
      .then((created) => {
        if (cancelled) {
          URL.revokeObjectURL(created);
          return;
        }
        url = created;
        setSource(created);
      })
      // A thumbnail that will not load is not worth an error message; the
      // icon stands in for it.
      .catch(() => undefined);

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [attachment, isImage]);

  if (isImage && source) {
    return (
      <img
        src={source}
        alt={attachment.fileName}
        className="h-10 w-10 shrink-0 rounded-md object-cover"
      />
    );
  }

  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink-muted">
      <TypeIcon mimeType={attachment.mimeType} />
    </span>
  );
}

/** Enough of a hint to tell a spreadsheet from a contract at a glance. */
function TypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <FileImage size={18} aria-hidden />;
  if (mimeType.includes('sheet') || mimeType === 'text/csv') {
    return <FileSpreadsheet size={18} aria-hidden />;
  }
  if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) {
    return <FileText size={18} aria-hidden />;
  }
  return <File size={18} aria-hidden />;
}

async function fetchBlob(attachment: Attachment): Promise<string> {
  const token = getAccessToken();
  const response = await fetch(attachment.downloadUrl, {
    credentials: 'include',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  });
  if (!response.ok) throw new Error('Could not load the file.');
  return URL.createObjectURL(await response.blob());
}

async function download(attachment: Attachment): Promise<void> {
  const url = await fetchBlob(attachment);
  const link = document.createElement('a');
  link.href = url;
  link.download = attachment.fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
