import { describe, expect, it } from 'vitest';
import {
  editedFileName,
  fitWithin,
  hasMetadata,
  isJpeg,
  jpegSegments,
  orientationFix,
  outputType,
  pixelateRegion,
  readExifOrientation,
  stripJpegMetadata,
} from '@/lib/imageBytes';

/**
 * The image pipeline that runs before anything is uploaded.
 *
 * The EXIF tests build real JPEG bytes rather than using a fixture, so what
 * is being asserted is visible in the test: here is an APP1 segment with an
 * orientation tag and a GPS latitude in it, and here is the same file with
 * both gone.
 */

// ---------------------------------------------------------------- fixtures

interface ExifOptions {
  orientation?: number;
  littleEndian?: boolean;
  withGps?: boolean;
  comment?: string;
}

/**
 * A JPEG carrying an EXIF APP1 segment, and nothing else of substance.
 *
 * The scan data is a token two bytes: none of this decodes as a picture, and
 * none of these functions decodes one. They read and rewrite the header.
 */
function jpegWithExif(options: ExifOptions = {}): Uint8Array {
  const { orientation = 1, littleEndian = true, withGps = false, comment } = options;

  const entries: Array<{ tag: number; type: number; count: number; value: number }> = [
    { tag: 0x0112, type: 3, count: 1, value: orientation },
  ];
  // 0x8825 is the pointer to the GPS IFD: the tag whose presence means the
  // file knows where it was taken.
  if (withGps) entries.push({ tag: 0x8825, type: 4, count: 1, value: 0x5a5a5a5a });

  const ifdSize = 2 + entries.length * 12 + 4;
  const tiff = new Uint8Array(8 + ifdSize);
  const view = new DataView(tiff.buffer);
  const le = littleEndian;

  tiff[0] = le ? 0x49 : 0x4d;
  tiff[1] = le ? 0x49 : 0x4d;
  view.setUint16(2, 0x002a, le);
  view.setUint32(4, 8, le);

  view.setUint16(8, entries.length, le);
  entries.forEach((entry, index) => {
    const at = 10 + index * 12;
    view.setUint16(at, entry.tag, le);
    view.setUint16(at + 2, entry.type, le);
    view.setUint32(at + 4, entry.count, le);
    // A SHORT sits in the top or bottom half of the value field depending on
    // byte order, which is the detail a big-endian file gets wrong if the
    // reader assumes little.
    if (entry.type === 3) view.setUint16(at + 8, entry.value, le);
    else view.setUint32(at + 8, entry.value, le);
  });
  view.setUint32(10 + entries.length * 12, 0, le);

  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const app1Payload = [...exifHeader, ...tiff];
  const app1Length = app1Payload.length + 2;

  const bytes: number[] = [
    0xff,
    0xd8, // SOI
    0xff,
    0xe1,
    (app1Length >> 8) & 0xff,
    app1Length & 0xff,
    ...app1Payload,
  ];

  if (comment) {
    const text = [...comment].map((character) => character.charCodeAt(0));
    const length = text.length + 2;
    bytes.push(0xff, 0xfe, (length >> 8) & 0xff, length & 0xff, ...text);
  }

  bytes.push(
    0xff,
    0xdb,
    0x00,
    0x04,
    0x00,
    0x00, // a token quantisation table
    0xff,
    0xda,
    0x00,
    0x02, // SOS
    0x12,
    0x34, // "pixels"
    0xff,
    0xd9, // EOI
  );

  return new Uint8Array(bytes);
}

function image(width: number, height: number, fill = 0): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height * 4).fill(fill);
}

// ------------------------------------------------------------ the EXIF strip

describe('reading the orientation', () => {
  it('finds it in a little-endian file', () => {
    expect(readExifOrientation(jpegWithExif({ orientation: 6 }))).toBe(6);
  });

  it('finds it in a big-endian file', () => {
    // "MM" files are rarer and are exactly where an endianness bug hides.
    expect(readExifOrientation(jpegWithExif({ orientation: 8, littleEndian: false }))).toBe(8);
  });

  it('says 1 when there is no EXIF at all', () => {
    const plain = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x11, 0xff, 0xd9]);
    expect(readExifOrientation(plain)).toBe(1);
  });

  it('says 1 rather than throwing on something that is not a JPEG', () => {
    expect(readExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
    expect(readExifOrientation(new Uint8Array())).toBe(1);
  });

  it('says 1 for a value outside the eight the spec defines', () => {
    expect(readExifOrientation(jpegWithExif({ orientation: 99 }))).toBe(1);
  });
});

describe('stripping the metadata', () => {
  it('removes the EXIF segment, GPS and all', () => {
    const withGps = jpegWithExif({ orientation: 6, withGps: true });

    // The GPS pointer is really in there to begin with, or this proves nothing.
    expect(hasMetadata(withGps)).toBe(true);
    expect(readExifOrientation(withGps)).toBe(6);

    const stripped = stripJpegMetadata(withGps);

    expect(hasMetadata(stripped), 'no metadata segment may survive').toBe(false);
    expect(readExifOrientation(stripped), 'nothing left to read').toBe(1);
    expect(
      jpegSegments(stripped).some((segment) => segment.marker === 0xe1),
      'the APP1 segment is gone',
    ).toBe(false);
  });

  it('removes comment segments too', () => {
    const chatty = jpegWithExif({ comment: 'Taken at home, do not share' });
    const stripped = stripJpegMetadata(chatty);

    const text = new TextDecoder('latin1').decode(stripped);
    expect(text).not.toContain('do not share');
    expect(hasMetadata(stripped)).toBe(false);
  });

  it('keeps the image itself: still a JPEG, and the scan data is untouched', () => {
    const stripped = stripJpegMetadata(jpegWithExif({ orientation: 3, withGps: true }));

    expect(isJpeg(stripped)).toBe(true);

    // The tail is the scan marker, its length, the two "pixels", then EOI.
    expect(Array.from(stripped.subarray(stripped.length - 8))).toEqual([
      0xff, 0xda, 0x00, 0x02, 0x12, 0x34, 0xff, 0xd9,
    ]);
  });

  it('is shorter than what went in, and leaves a clean file alone', () => {
    const fat = jpegWithExif({ withGps: true, comment: 'hello' });
    const lean = stripJpegMetadata(fat);
    expect(lean.length).toBeLessThan(fat.length);

    // Nothing to remove: the same bytes come back rather than a rebuilt copy.
    expect(stripJpegMetadata(lean)).toBe(lean);
  });

  it('passes a non-JPEG through unchanged', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(stripJpegMetadata(png)).toBe(png);
  });
});

// -------------------------------------------------------------- the downscale

describe('the downscale', () => {
  it('brings the longest side to 2560 and keeps the shape', () => {
    const fitted = fitWithin({ width: 4032, height: 3024 }, 2560);

    expect(Math.max(fitted.width, fitted.height)).toBe(2560);
    expect(fitted.width).toBe(2560);
    expect(fitted.height).toBe(1920);
    // 4:3 in, 4:3 out.
    expect(fitted.width / fitted.height).toBeCloseTo(4032 / 3024, 2);
  });

  it('works on a portrait image, where the long side is the height', () => {
    const fitted = fitWithin({ width: 3024, height: 4032 }, 2560);
    expect(fitted.height).toBe(2560);
    expect(fitted.width).toBe(1920);
  });

  it('never scales up', () => {
    expect(fitWithin({ width: 800, height: 600 }, 2560)).toEqual({ width: 800, height: 600 });
    expect(fitWithin({ width: 2560, height: 100 }, 2560)).toEqual({ width: 2560, height: 100 });
  });

  it('keeps at least one pixel on an extreme panorama', () => {
    // 10000x1 scaled to 2560 rounds the height to zero, which is a canvas error.
    const fitted = fitWithin({ width: 10000, height: 1 }, 2560);
    expect(fitted.width).toBe(2560);
    expect(fitted.height).toBe(1);
  });
});

describe('baking in the orientation', () => {
  it('swaps the axes for the four rotated cases, and not for the others', () => {
    const size = { width: 400, height: 300 };

    for (const orientation of [1, 2, 3, 4]) {
      expect(orientationFix(orientation, size).size, 'orientation ' + orientation).toEqual(size);
    }
    for (const orientation of [5, 6, 7, 8]) {
      expect(orientationFix(orientation, size).size, 'orientation ' + orientation).toEqual({
        width: 300,
        height: 400,
      });
    }
  });

  it('leaves an upright image untransformed', () => {
    const fix = orientationFix(1, { width: 400, height: 300 });
    expect(fix.transform).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('maps the corners where they belong for a 90 degree turn', () => {
    // Orientation 6 is the common phone case: turn clockwise. The top-left of
    // the stored image must land at the top-right of the displayed one.
    const size = { width: 400, height: 300 };
    const { transform } = orientationFix(6, size);
    const [a, b, c, d, e, f] = transform as [number, number, number, number, number, number];
    const apply = (x: number, y: number) => ({ x: a * x + c * y + e, y: b * x + d * y + f });

    expect(apply(0, 0)).toEqual({ x: 300, y: 0 });
    expect(apply(400, 0)).toEqual({ x: 300, y: 400 });
    expect(apply(0, 300)).toEqual({ x: 0, y: 0 });
  });
});

// ------------------------------------------------------------------ the blur

describe('the blur tool', () => {
  it('covers the selected area and nothing outside it', () => {
    const size = { width: 10, height: 10 };
    const data = image(10, 10, 0);

    // A white block to hide, inside the selection.
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        const at = (y * 10 + x) * 4;
        data[at] = 255;
        data[at + 1] = 255;
        data[at + 2] = 255;
        data[at + 3] = 255;
      }
    }
    // And one outside it, which must survive untouched.
    const outside = (8 * 10 + 8) * 4;
    data[outside] = 123;
    data[outside + 3] = 255;

    pixelateRegion(data, size, { x: 2, y: 2, width: 4, height: 4 }, 4);

    // Every pixel of the selection now holds the block average, so the shape
    // that was in there is gone rather than softened.
    const first = (2 * 10 + 2) * 4;
    const average = data[first] as number;
    for (let y = 2; y < 6; y += 1) {
      for (let x = 2; x < 6; x += 1) {
        expect(data[(y * 10 + x) * 4], 'pixel ' + x + ',' + y).toBe(average);
      }
    }

    expect(data[outside], 'a pixel outside the selection must not change').toBe(123);
  });

  it('destroys the detail rather than averaging it away to nothing', () => {
    /*
     * A checkerboard inside the area: every block must come out a single
     * colour, which is what makes text unreadable afterwards.
     */
    const size = { width: 8, height: 8 };
    const data = image(8, 8, 0);
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const at = (y * 8 + x) * 4;
        const value = (x + y) % 2 === 0 ? 0 : 255;
        data[at] = value;
        data[at + 1] = value;
        data[at + 2] = value;
        data[at + 3] = 255;
      }
    }

    pixelateRegion(data, size, { x: 0, y: 0, width: 8, height: 8 }, 4);

    const corner = data[0] as number;
    let varied = false;
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if (data[(y * 8 + x) * 4] !== corner) varied = true;
      }
    }
    expect(varied, 'a block must be one flat colour').toBe(false);
    // The average of an even checkerboard, not black and not white.
    expect(corner).toBeGreaterThan(100);
    expect(corner).toBeLessThan(155);
  });

  it('clamps a selection dragged off the edge', () => {
    const size = { width: 6, height: 6 };
    const data = image(6, 6, 40);

    expect(() =>
      pixelateRegion(data, size, { x: -20, y: -20, width: 100, height: 100 }, 3),
    ).not.toThrow();
    expect(data.length).toBe(6 * 6 * 4);
  });

  it('leaves the image alone when the selection has no area', () => {
    const size = { width: 4, height: 4 };
    const data = image(4, 4, 70);
    const before = Array.from(data);

    pixelateRegion(data, size, { x: 2, y: 2, width: 0, height: 0 }, 4);
    expect(Array.from(data)).toEqual(before);
  });
});

// --------------------------------------------------------------- the output

describe('choosing the output format', () => {
  it('keeps a screenshot lossless and a photograph at 0.9', () => {
    expect(outputType('image/png')).toEqual({ type: 'image/png', quality: 1 });
    expect(outputType('image/jpeg')).toEqual({ type: 'image/jpeg', quality: 0.9 });
  });

  it('treats anything else as a screenshot, which is the safe way round', () => {
    // Re-encoding flat colour as JPEG is visibly worse; the other way costs
    // only bytes.
    expect(outputType('image/webp').type).toBe('image/png');
    expect(outputType('image/gif').type).toBe('image/png');
  });

  it('names the edited copy after the original', () => {
    expect(editedFileName('screenshot.png', 'image/png')).toBe('screenshot-edited.png');
    expect(editedFileName('photo.jpeg', 'image/jpeg')).toBe('photo-edited.jpg');
    expect(editedFileName('no-extension', 'image/png')).toBe('no-extension-edited.png');
    // A dotfile has no stem to speak of; the name must still be usable.
    expect(editedFileName('.hidden', 'image/png')).toBe('.hidden-edited.png');
  });
});
