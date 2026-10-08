import { MARKUP_CHROME } from '@/features/tasks/markup';
import {
  editedFileName,
  fitWithin,
  isJpeg,
  orientationFix,
  outputType,
  readExifOrientation,
  stripJpegMetadata,
  type Size,
} from './imageBytes';

/**
 * Getting an image ready to upload.
 *
 * Three things happen to every image on its way out, and all three are
 * decided here rather than at each call site, because "the screenshot in the
 * create drawer kept its GPS" is exactly the bug that two code paths cause.
 *
 *   1. The EXIF orientation is baked into the pixels, so the picture is the
 *      right way up wherever it is shown.
 *   2. All metadata goes. Re-drawing through a canvas drops it as a side
 *      effect; the byte-level strip afterwards is there so the guarantee does
 *      not rest on a side effect.
 *   3. The longest side comes down to 2560px, which is plenty to read a
 *      screenshot by and a fifth of the bytes of a modern phone photo.
 *
 * The browser half lives here; the parts worth testing are in imageBytes.
 */

export const MAX_IMAGE_SIDE = 2560;

/** SVG is an image to the browser but a document to a canvas: left alone. */
export function isPreparableImage(type: string): boolean {
  return type.startsWith('image/') && type !== 'image/svg+xml';
}

function canvasOf(size: Size): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give us a canvas to work on.');

  return { canvas, context };
}

async function blobOf(
  canvas: HTMLCanvasElement,
  type: 'image/png' | 'image/jpeg',
  quality: number,
): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob) throw new Error('The image could not be encoded.');
  return blob;
}

/**
 * Draws a bitmap at a size, turned the right way up.
 *
 * The orientation transform and the scale are applied together, so the image
 * is resampled once. Doing it in two passes costs sharpness for nothing.
 */
export function drawUpright(
  source: CanvasImageSource,
  natural: Size,
  orientation: number,
  target: Size,
): HTMLCanvasElement {
  const fix = orientationFix(orientation, natural);
  const scale = {
    x: target.width / fix.size.width,
    y: target.height / fix.size.height,
  };

  const { canvas, context } = canvasOf(target);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  const [a, b, c, d, e, f] = fix.transform;
  context.setTransform(
    a * scale.x,
    b * scale.y,
    c * scale.x,
    d * scale.y,
    e * scale.x,
    f * scale.y,
  );
  context.drawImage(source, 0, 0);
  context.setTransform(1, 0, 0, 1, 0, 0);

  return canvas;
}

export interface PreparedImage {
  file: File;
  /** The size after the rotation and the downscale. */
  size: Size;
  /** True when anything actually changed, for telling the user why. */
  changed: boolean;
  /** A URL for showing it. The caller revokes it. */
  previewUrl: string;
}

/**
 * The orientation, read from the bytes rather than left to the decoder.
 *
 * `createImageBitmap` can be asked to apply EXIF orientation itself, but
 * support is uneven and a wrong guess rotates a photo twice. Reading the tag
 * and applying it with `imageOrientation: 'none'` gives one answer
 * everywhere.
 */
async function orientationOf(file: File, bytes: Uint8Array): Promise<number> {
  if (!isJpeg(bytes)) return 1;
  return readExifOrientation(bytes);
}

/** Fixes orientation, strips metadata, and downscales. */
export async function prepareImageForUpload(file: File): Promise<PreparedImage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const orientation = await orientationOf(file, bytes);

  // 'none' because the rotation is applied by hand, from the tag just read.
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: file.type }), {
    imageOrientation: 'none',
  });

  try {
    const natural = { width: bitmap.width, height: bitmap.height };
    const upright = orientationFix(orientation, natural).size;
    const target = fitWithin(upright, MAX_IMAGE_SIDE);

    const { type, quality } = outputType(file.type);
    const canvas = drawUpright(bitmap, natural, orientation, target);
    const encoded = await blobOf(canvas, type, quality);

    /*
     * The canvas encoder writes no EXIF, so this finds nothing to remove on
     * every normal path. It runs anyway: it is cheap, and it is the only
     * thing standing between a GPS tag and the server if some browser ever
     * decides to be helpful and copy the metadata across.
     */
    const clean = stripJpegMetadata(new Uint8Array(await encoded.arrayBuffer()));
    const finalBlob = new Blob([clean as BlobPart], { type });

    const name =
      type === file.type ? file.name : editedFileName(file.name, type).replace('-edited', '');
    const prepared = new File([finalBlob], name, { type, lastModified: Date.now() });

    return {
      file: prepared,
      size: target,
      changed:
        orientation !== 1 ||
        target.width !== natural.width ||
        target.height !== natural.height ||
        type !== file.type,
      previewUrl: URL.createObjectURL(finalBlob),
    };
  } finally {
    bitmap.close();
  }
}

/** Turns a canvas from the editor into a file, by the same output rules. */
export async function canvasToUpload(
  canvas: HTMLCanvasElement,
  originalName: string,
  originalType: string,
): Promise<File> {
  const { type, quality } = outputType(originalType);
  const blob = await blobOf(canvas, type, quality);
  const clean = stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()));

  return new File([new Blob([clean as BlobPart], { type })], editedFileName(originalName, type), {
    type,
    lastModified: Date.now(),
  });
}

export interface PdfPreview {
  previewUrl: string;
  pageCount: number;
}

/**
 * The first page of a PDF, drawn to an image, with the page count.
 *
 * A reviewer can tell one signed contract from another by looking at it, and
 * cannot by reading "contract-final-v3.pdf". The worker is loaded from the
 * installed package rather than a CDN, so this works with the app's own
 * content-security policy and offline.
 */
export async function renderPdfFirstPage(file: File): Promise<PdfPreview> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;

  // The loading task owns the worker, so it is the thing to tear down.
  const loading = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const document_ = await loading.promise;

  try {
    const page = await document_.getPage(1);
    // Rendered at twice the preview box, so it is not soft on a retina screen.
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1400 / viewport.width, 2);
    const scaled = page.getViewport({ scale });

    const { canvas, context } = canvasOf({
      width: Math.ceil(scaled.width),
      height: Math.ceil(scaled.height),
    });
    context.fillStyle = MARKUP_CHROME.pageBackground;
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvas, canvasContext: context, viewport: scaled }).promise;
    const blob = await blobOf(canvas, 'image/png', 1);

    return { previewUrl: URL.createObjectURL(blob), pageCount: document_.numPages };
  } finally {
    await loading.destroy();
  }
}
