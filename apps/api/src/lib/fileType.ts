/**
 * What a file actually is, read from its first bytes.
 *
 * The browser's Content-Type and the file name are both supplied by whoever is
 * uploading, so neither can decide whether something is allowed. An executable
 * renamed to holiday.png announces itself as an image; its first bytes do not.
 *
 * Only the formats the product accepts are recognised. Anything unrecognised is
 * refused rather than guessed at.
 */

export interface SniffResult {
  /** The media type the bytes say this is. */
  mime: string;
  /** How the decision was reached, for the error message and the logs. */
  via: 'magic' | 'text';
}

const MAGIC: Array<{ mime: string; offset: number; bytes: number[] }> = [
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // The old Office formats, and .msg, share this compound-document header.
  {
    mime: 'application/vnd.ms-office',
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
];

/** WEBP is RIFF with a WEBP tag four bytes later. */
function isWebp(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}

/** Every modern Office file, and every .zip, is a zip archive. */
function isZip(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const signature = buffer.readUInt32LE(0);
  // "PK\x03\x04" for a normal archive, and the empty and spanned variants.
  return signature === 0x04034b50 || signature === 0x06054b50 || signature === 0x08074b50;
}

/**
 * A zip that is really an Office document names its type in the first entry.
 * Reading that lets an .xlsx be told apart from an arbitrary archive.
 */
function officeTypeFromZip(buffer: Buffer): string | null {
  const head = buffer.toString('latin1', 0, Math.min(buffer.length, 4096));
  if (head.includes('word/')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (head.includes('xl/')) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (head.includes('ppt/')) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  return null;
}

/**
 * Formats that must never be stored, whatever they are called.
 *
 * Checked before anything else. These are recognised not to classify them but
 * to refuse them outright.
 */
const EXECUTABLE_SIGNATURES: Array<{ name: string; bytes: number[] }> = [
  { name: 'DOS/Windows executable', bytes: [0x4d, 0x5a] }, // MZ
  { name: 'ELF binary', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Java class file', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'Mach-O binary', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'Mach-O binary', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'shell script', bytes: [0x23, 0x21] }, // #!
];

export function looksExecutable(buffer: Buffer): string | null {
  for (const candidate of EXECUTABLE_SIGNATURES) {
    if (
      buffer.length >= candidate.bytes.length &&
      candidate.bytes.every((byte, i) => buffer[i] === byte)
    ) {
      return candidate.name;
    }
  }
  return null;
}

/**
 * Does this look like text rather than a binary blob?
 *
 * Rejecting only control characters is not enough: a binary made of high bytes
 * has none, so an executable padded with 0x90 sailed through as text/plain and
 * was accepted. Real text is valid UTF-8, so that is what gets checked.
 */
function looksLikeText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  if (sample.length === 0) return true;

  for (const byte of sample) {
    // A null byte means binary. So do control characters other than tab,
    // newline and carriage return.
    if (byte === 0) return false;
    if (byte < 0x09) return false;
    if (byte > 0x0d && byte < 0x20) return false;
  }

  // Decode strictly. A truncated multi-byte sequence at the sample boundary
  // would be a false negative, so trim back to a character boundary first.
  let end = sample.length;
  while (end > 0 && (sample[end - 1] as number) >= 0x80) end -= 1;
  if (end === 0) return false;

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

export function sniffFileType(buffer: Buffer): SniffResult | null {
  // An executable is never acceptable, so it is not classified at all.
  if (looksExecutable(buffer)) return null;

  for (const candidate of MAGIC) {
    const slice = buffer.subarray(candidate.offset, candidate.offset + candidate.bytes.length);
    if (
      slice.length === candidate.bytes.length &&
      candidate.bytes.every((b, i) => slice[i] === b)
    ) {
      return { mime: candidate.mime, via: 'magic' };
    }
  }

  if (isWebp(buffer)) return { mime: 'image/webp', via: 'magic' };

  if (isZip(buffer)) {
    return { mime: officeTypeFromZip(buffer) ?? 'application/zip', via: 'magic' };
  }

  // SVG is text, so it is checked before the generic text case.
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 1024)).trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<svg')) {
    if (head.includes('<svg')) return { mime: 'image/svg+xml', via: 'text' };
  }

  if (looksLikeText(buffer)) return { mime: 'text/plain', via: 'text' };

  return null;
}

/**
 * Types that are close enough to accept for one another.
 *
 * A .csv is text, a .docx is a zip, and the old Office formats all share one
 * header, so an exact match between the declared type and the sniffed type
 * would reject perfectly ordinary files.
 */
const COMPATIBLE: Record<string, string[]> = {
  'text/plain': ['text/plain', 'text/csv'],
  'application/zip': [
    'application/zip',
    'application/x-zip-compressed',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  'application/vnd.ms-office': [
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
  ],
};

export interface VerifyResult {
  ok: boolean;
  /** The type to store, which is the sniffed one, never the declared one. */
  mime: string;
  reason?: string;
}

/**
 * Decide whether an upload may be stored.
 *
 * The allow list is checked against what the bytes say, not what the request
 * claimed. The declared type only has to be compatible; where they disagree,
 * the bytes win and are what gets recorded.
 */
export function verifyUpload(
  buffer: Buffer,
  declaredMime: string,
  allowed: readonly string[],
): VerifyResult {
  const executable = looksExecutable(buffer);
  if (executable) {
    return {
      ok: false,
      mime: 'application/octet-stream',
      reason: 'That file is a ' + executable + ', whatever it is named.',
    };
  }

  const sniffed = sniffFileType(buffer);

  if (!sniffed) {
    return { ok: false, mime: declaredMime, reason: 'The file type could not be recognised.' };
  }

  const equivalents = COMPATIBLE[sniffed.mime] ?? [sniffed.mime];
  const permitted = equivalents.filter((mime) => allowed.includes(mime));

  if (permitted.length === 0) {
    return {
      ok: false,
      mime: sniffed.mime,
      reason: 'Files of type ' + sniffed.mime + ' are not allowed.',
    };
  }

  // Prefer the declared type when the bytes permit it, so a .csv stays a .csv
  // and a .docx keeps its specific type rather than becoming a plain zip.
  const mime = permitted.includes(declaredMime) ? declaredMime : (permitted[0] as string);
  return { ok: true, mime };
}
