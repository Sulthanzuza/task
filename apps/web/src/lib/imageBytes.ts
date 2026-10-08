/**
 * Reading and rewriting JPEG bytes, without a canvas.
 *
 * Two jobs that have to happen before an image leaves the browser: read the
 * EXIF orientation so the picture can be turned the right way up, and make
 * sure none of the rest of the EXIF goes with it. A photograph taken on a
 * phone carries the phone, the lens, the date, and often the GPS coordinates
 * of where it was taken. None of that belongs on a task.
 *
 * Re-encoding through a canvas drops metadata as a side effect, and that is
 * what the upload path does. These functions exist so the guarantee is a
 * thing that can be stated and tested on its own rather than a hope about
 * what the browser's encoder happens to do — and because the orientation has
 * to be read out before the pixels are handed to the canvas.
 *
 * Pure byte functions: no DOM, so the tests run in Node.
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP1 = 0xe1;
const COM = 0xfe;

/** Segments that carry no pixels and are dropped on the way out. */
function isMetadataMarker(marker: number): boolean {
  // APP0 to APP15 (0xe0-0xef) and the comment segment. APP0 is the JFIF
  // header, which is harmless, but it is also not needed: a bare JPEG with
  // no APPn at all decodes everywhere.
  return (marker >= 0xe0 && marker <= 0xef) || marker === COM;
}

export interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF that starts the marker. */
  start: number;
  /** Offset just past the segment's payload. */
  end: number;
}

/**
 * Walks the segments before the first scan.
 *
 * Stops at SOS, because everything after it is entropy-coded pixel data that
 * must be copied through untouched.
 */
export function jpegSegments(bytes: Uint8Array): JpegSegment[] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return [];

  const segments: JpegSegment[] = [];
  let at = 2;

  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) break;

    const marker = bytes[at + 1] as number;
    if (marker === SOS || marker === EOI) break;

    // Standalone markers (RSTn, TEM) carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start: at, end: at + 2 });
      at += 2;
      continue;
    }

    const length = ((bytes[at + 2] as number) << 8) | (bytes[at + 3] as number);
    if (length < 2) break;

    segments.push({ marker, start: at, end: at + 2 + length });
    at += 2 + length;
  }

  return segments;
}

/** True when the bytes begin with a JPEG start-of-image marker. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === SOI;
}

/**
 * The EXIF orientation, 1 to 8, or 1 when there is none to read.
 *
 * 1 means "already the right way up". The others describe a rotation, a
 * mirror, or both, which a decoder is free to ignore — and several do, which
 * is why a photo from a phone so often arrives on its side.
 */
export function readExifOrientation(bytes: Uint8Array): number {
  if (!isJpeg(bytes)) return 1;

  const app1 = jpegSegments(bytes).find((segment) => segment.marker === APP1);
  if (!app1) return 1;

  const header = app1.start + 4;
  // "Exif\0\0"
  const isExif =
    bytes[header] === 0x45 &&
    bytes[header + 1] === 0x78 &&
    bytes[header + 2] === 0x69 &&
    bytes[header + 3] === 0x66;
  if (!isExif) return 1;

  const tiff = header + 6;
  if (tiff + 8 > bytes.length) return 1;

  // "II" is little-endian, "MM" big-endian. Both occur in the wild.
  const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
  const u16 = (at: number): number =>
    little
      ? (bytes[at] as number) | ((bytes[at + 1] as number) << 8)
      : ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
  const u32 = (at: number): number =>
    little
      ? (bytes[at] as number) |
        ((bytes[at + 1] as number) << 8) |
        ((bytes[at + 2] as number) << 16) |
        ((bytes[at + 3] as number) << 24)
      : ((bytes[at] as number) << 24) |
        ((bytes[at + 1] as number) << 16) |
        ((bytes[at + 2] as number) << 8) |
        (bytes[at + 3] as number);

  const ifd0 = tiff + u32(tiff + 4);
  if (ifd0 + 2 > bytes.length) return 1;

  const count = u16(ifd0);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd0 + 2 + i * 12;
    if (entry + 12 > bytes.length) break;

    // 0x0112 is Orientation, stored as a SHORT in the value field.
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }

  return 1;
}

/**
 * The same JPEG with every metadata segment removed.
 *
 * The pixels are untouched: this is a copy with holes cut out of the header,
 * not a re-encode, so it cannot lose quality.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (!isJpeg(bytes)) return bytes;

  const drop = jpegSegments(bytes).filter((segment) => isMetadataMarker(segment.marker));
  if (drop.length === 0) return bytes;

  const removed = drop.reduce((total, segment) => total + (segment.end - segment.start), 0);
  const out = new Uint8Array(bytes.length - removed);

  let write = 0;
  let read = 0;
  for (const segment of drop) {
    out.set(bytes.subarray(read, segment.start), write);
    write += segment.start - read;
    read = segment.end;
  }
  out.set(bytes.subarray(read), write);

  return out;
}

/** True when any EXIF or comment segment is still present. */
export function hasMetadata(bytes: Uint8Array): boolean {
  return jpegSegments(bytes).some((segment) => isMetadataMarker(segment.marker));
}

export interface Size {
  width: number;
  height: number;
}

/**
 * Scaled down to fit a longest side, never scaled up.
 *
 * An image already within the limit comes back unchanged, so a screenshot is
 * not re-sampled for no reason.
 */
export function fitWithin(size: Size, longestSide: number): Size {
  const longest = Math.max(size.width, size.height);
  if (longest <= longestSide) return { width: size.width, height: size.height };

  const scale = longestSide / longest;
  return {
    // At least one pixel: a 4000x1 panorama must not come back zero-high.
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

export interface OrientationFix {
  /** The size after the rotation, which swaps the axes for 5 to 8. */
  size: Size;
  /** A canvas transform, as setTransform takes it. */
  transform: [number, number, number, number, number, number];
}

/**
 * How to draw an image so its EXIF orientation is baked into the pixels.
 *
 * Written out per case rather than composed from rotate and scale calls,
 * because the eight cases are a fixed table in the spec and reading them
 * back as a table is the only way to check them.
 */
export function orientationFix(orientation: number, size: Size): OrientationFix {
  const { width: w, height: h } = size;
  const swapped = { width: h, height: w };

  switch (orientation) {
    case 2: // mirrored horizontally
      return { size, transform: [-1, 0, 0, 1, w, 0] };
    case 3: // 180 degrees
      return { size, transform: [-1, 0, 0, -1, w, h] };
    case 4: // mirrored vertically
      return { size, transform: [1, 0, 0, -1, 0, h] };
    case 5: // mirrored, then 90 clockwise
      return { size: swapped, transform: [0, 1, 1, 0, 0, 0] };
    case 6: // 90 clockwise
      return { size: swapped, transform: [0, 1, -1, 0, h, 0] };
    case 7: // mirrored, then 90 anticlockwise
      return { size: swapped, transform: [0, -1, -1, 0, h, w] };
    case 8: // 90 anticlockwise
      return { size: swapped, transform: [0, -1, 1, 0, 0, w] };
    default:
      return { size, transform: [1, 0, 0, 1, 0, 0] };
  }
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Pixelates a rectangle in place, as the editor's blur tool.
 *
 * Averaging each block and writing the average back is a mosaic rather than a
 * blur, and that is deliberate: a Gaussian blur of readable text can often be
 * reversed well enough to read it again, and a strong mosaic cannot. The tool
 * is there to hide a customer's name or an API key, so it has to actually
 * destroy the information rather than make it look hidden.
 */
export function pixelateRegion(
  data: Uint8ClampedArray,
  size: Size,
  rect: Rect,
  blockSize: number,
): Uint8ClampedArray {
  const block = Math.max(2, Math.floor(blockSize));

  // Clamped to the image, so a selection dragged off the edge is not a crash.
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(size.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(size.height, Math.ceil(rect.y + rect.height));

  for (let blockTop = top; blockTop < bottom; blockTop += block) {
    for (let blockLeft = left; blockLeft < right; blockLeft += block) {
      const blockRight = Math.min(blockLeft + block, right);
      const blockBottom = Math.min(blockTop + block, bottom);

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;

      for (let y = blockTop; y < blockBottom; y += 1) {
        for (let x = blockLeft; x < blockRight; x += 1) {
          const at = (y * size.width + x) * 4;
          r += data[at] as number;
          g += data[at + 1] as number;
          b += data[at + 2] as number;
          a += data[at + 3] as number;
          n += 1;
        }
      }

      if (n === 0) continue;
      const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];

      for (let y = blockTop; y < blockBottom; y += 1) {
        for (let x = blockLeft; x < blockRight; x += 1) {
          const at = (y * size.width + x) * 4;
          data[at] = avg[0] as number;
          data[at + 1] = avg[1] as number;
          data[at + 2] = avg[2] as number;
          data[at + 3] = avg[3] as number;
        }
      }
    }
  }

  return data;
}

/**
 * PNG for a screenshot, JPEG for a photograph.
 *
 * A screenshot is flat colour and sharp edges, which JPEG smears and PNG
 * keeps exactly; a photograph is the other way round, and a PNG of one can be
 * ten times the size for no visible gain. The source type is the best signal
 * available: a phone camera gives JPEG, a screen capture gives PNG.
 */
export function outputType(sourceType: string): {
  type: 'image/png' | 'image/jpeg';
  quality: number;
} {
  if (sourceType === 'image/jpeg') return { type: 'image/jpeg', quality: 0.9 };
  return { type: 'image/png', quality: 1 };
}

/** The upload name for an edited copy: screenshot.png becomes screenshot-edited.png. */
export function editedFileName(original: string, type: 'image/png' | 'image/jpeg'): string {
  const extension = type === 'image/png' ? '.png' : '.jpg';
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original;
  return stem + '-edited' + extension;
}
