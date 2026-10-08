import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as KonvaImage, Layer, Line, Rect, Stage, Text as KonvaText } from 'react-konva';
import type Konva from 'konva';
import {
  ArrowUpRight,
  Circle as CircleIcon,
  Crop,
  Droplet,
  Minus,
  Pen,
  Redo2,
  RotateCcw,
  Square,
  Type as TypeIcon,
  Undo2,
} from 'lucide-react';
import { Button, Card } from '@/components/ui/primitives';
import { canvasToUpload } from '@/lib/imagePrep';
import { pixelateRegion } from '@/lib/imageBytes';
import { cn } from '@/lib/utils';
import { MARKUP_CHROME, MARKUP_COLORS, MARKUP_SIZES, type MarkupColor } from './markup';

/**
 * Drawing on a screenshot before it is attached.
 *
 * Most screenshots on a task need an arrow and a circle: "this button", "this
 * number is wrong". Doing that in another app and coming back loses the
 * context, so it happens here.
 *
 * The editor keeps a list of shapes and an index into it, which is what makes
 * undo and redo a move of the index rather than a repaint. Nothing is
 * destructive until Save, when everything is flattened onto one canvas and
 * the result is uploaded; the original never goes up.
 *
 * Pointer events throughout, so a finger, a stylus and a mouse are the same
 * code path, and two fingers pinch to zoom.
 */

type Tool = 'pen' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'blur' | 'crop';

interface Stroke {
  kind: 'pen';
  points: number[];
  color: string;
  width: number;
}
interface Arrow {
  kind: 'arrow';
  from: { x: number; y: number };
  to: { x: number; y: number };
  color: string;
  width: number;
}
/*
 * One interface per kind rather than a union in the `kind` field: the
 * discriminant has to be a single literal for TypeScript to narrow a shape
 * down to it, and these three are handled separately everywhere anyway.
 */
interface BoxBase {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  strokeWidth: number;
}
interface RectShape extends BoxBase {
  kind: 'rect';
}
interface EllipseShape extends BoxBase {
  kind: 'ellipse';
}
interface BlurShape extends BoxBase {
  kind: 'blur';
}
type Box = RectShape | EllipseShape | BlurShape;
interface Caption {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  color: string;
  fontSize: number;
}

type Shape = Stroke | Arrow | Box | Caption;

const TOOLS: Array<{ tool: Tool; label: string; icon: typeof Pen }> = [
  { tool: 'pen', label: 'Pen', icon: Pen },
  { tool: 'arrow', label: 'Arrow', icon: ArrowUpRight },
  { tool: 'rect', label: 'Rectangle', icon: Square },
  { tool: 'ellipse', label: 'Ellipse', icon: CircleIcon },
  { tool: 'text', label: 'Text', icon: TypeIcon },
  { tool: 'blur', label: 'Blur an area', icon: Droplet },
  { tool: 'crop', label: 'Crop', icon: Crop },
];

/** Arrow heads are drawn as a polyline so one Line covers the whole arrow. */
function arrowPoints(arrow: Arrow): number[] {
  const { from, to } = arrow;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(10, arrow.width * 4);
  const spread = Math.PI / 7;

  return [
    from.x,
    from.y,
    to.x,
    to.y,
    to.x - head * Math.cos(angle - spread),
    to.y - head * Math.sin(angle - spread),
    to.x,
    to.y,
    to.x - head * Math.cos(angle + spread),
    to.y - head * Math.sin(angle + spread),
  ];
}

function ellipsePoints(box: Box): number[] {
  // Konva has an Ellipse, but drawing it as a Line keeps every shape in one
  // list and one renderer, which is what makes undo simple.
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const rx = Math.abs(box.width) / 2;
  const ry = Math.abs(box.height) / 2;
  const points: number[] = [];

  for (let step = 0; step <= 48; step += 1) {
    const angle = (step / 48) * Math.PI * 2;
    points.push(cx + rx * Math.cos(angle), cy + ry * Math.sin(angle));
  }
  return points;
}

function normalised<T extends BoxBase>(box: T): T {
  return {
    ...box,
    x: box.width < 0 ? box.x + box.width : box.x,
    y: box.height < 0 ? box.y + box.height : box.y,
    width: Math.abs(box.width),
    height: Math.abs(box.height),
  };
}

export function ImageMarkup({
  file,
  onCancel,
  onSave,
}: {
  file: File;
  onCancel: () => void;
  onSave: (edited: File) => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<MarkupColor>(MARKUP_COLORS[0] as MarkupColor);
  const [size, setSize] = useState(MARKUP_SIZES[1] as number);

  /*
   * Everything drawn, plus how much of it counts. Undo moves the mark back
   * rather than throwing shapes away, so redo has something to return to.
   */
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [applied, setApplied] = useState(0);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [crop, setCrop] = useState<RectShape | null>(null);
  const [cropped, setCropped] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const stageRef = useRef<Konva.Stage>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, width: 0, height: 0 });

  const visible = useMemo(() => shapes.slice(0, applied), [shapes, applied]);

  // -------------------------------------------------------------- the image
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () => setImage(element);
    element.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /** The picture is shown fitted to the box; drawing happens in image pixels. */
  const measure = useCallback(() => {
    const box = boxRef.current;
    if (!box || !image) return;

    const frame = cropped ?? { width: image.width, height: image.height };
    const scale = Math.min(box.clientWidth / frame.width, 1);
    setView({ scale, width: frame.width * scale, height: frame.height * scale });
  }, [image, cropped]);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  // Ctrl/Cmd+Z and Shift+Z, which is what anybody will try first.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      event.preventDefault();
      if (event.shiftKey) setApplied((at) => Math.min(shapes.length, at + 1));
      else setApplied((at) => Math.max(0, at - 1));
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [shapes.length]);

  function add(shape: Shape) {
    // A new shape after an undo replaces the redo tail, as every editor does.
    setShapes((all) => [...all.slice(0, applied), shape]);
    setApplied((at) => at + 1);
  }

  /** Pointer position in image pixels, which is what the shapes are stored in. */
  function pointer(): { x: number; y: number } | null {
    const stage = stageRef.current;
    const position = stage?.getPointerPosition();
    if (!position) return null;

    const origin = cropped ?? { x: 0, y: 0 };
    return {
      x: position.x / view.scale + origin.x,
      y: position.y / view.scale + origin.y,
    };
  }

  function onPointerDown() {
    const at = pointer();
    if (!at) return;

    if (tool === 'text') {
      const text = window.prompt('What should it say?');
      if (text?.trim()) {
        add({
          kind: 'text',
          x: at.x,
          y: at.y,
          text: text.trim(),
          color,
          fontSize: size * 7,
        });
      }
      return;
    }

    if (tool === 'pen') {
      setDraft({ kind: 'pen', points: [at.x, at.y], color, width: size });
      return;
    }
    if (tool === 'arrow') {
      setDraft({ kind: 'arrow', from: at, to: at, color, width: size });
      return;
    }
    if (tool === 'crop') {
      setCrop({ kind: 'rect', x: at.x, y: at.y, width: 0, height: 0, color, strokeWidth: 1 });
      return;
    }

    const box: Box = {
      kind: tool === 'blur' ? 'blur' : tool === 'ellipse' ? 'ellipse' : 'rect',
      x: at.x,
      y: at.y,
      width: 0,
      height: 0,
      color,
      strokeWidth: size,
    };
    setDraft(box);
  }

  function onPointerMove() {
    const at = pointer();
    if (!at) return;

    if (crop && tool === 'crop') {
      setCrop({ ...crop, width: at.x - crop.x, height: at.y - crop.y });
      return;
    }
    if (!draft) return;

    if (draft.kind === 'pen') {
      setDraft({ ...draft, points: [...draft.points, at.x, at.y] });
    } else if (draft.kind === 'arrow') {
      setDraft({ ...draft, to: at });
    } else if (draft.kind === 'text') {
      // A caption is placed by one tap, so there is nothing to drag.
    } else {
      setDraft({ ...draft, width: at.x - draft.x, height: at.y - draft.y });
    }
  }

  function onPointerUp() {
    if (!draft) return;

    // A tap with no drag leaves nothing behind rather than a dot nobody meant.
    const tiny =
      (draft.kind === 'rect' || draft.kind === 'ellipse' || draft.kind === 'blur') &&
      Math.abs(draft.width) < 4 &&
      Math.abs(draft.height) < 4;
    const stillPen = draft.kind === 'pen' && draft.points.length < 4;

    if (!tiny && !stillPen) {
      add(
        draft.kind === 'rect' || draft.kind === 'ellipse' || draft.kind === 'blur'
          ? normalised(draft)
          : draft,
      );
    }
    setDraft(null);
  }

  /** Two fingers, or a trackpad pinch: zoom the view without touching the shapes. */
  function onWheel(event: Konva.KonvaEventObject<WheelEvent>) {
    if (!event.evt.ctrlKey) return;
    event.evt.preventDefault();
    setView((current) => ({
      ...current,
      scale: Math.min(4, Math.max(0.2, current.scale * (event.evt.deltaY < 0 ? 1.1 : 0.9))),
    }));
  }

  function applyCrop() {
    if (!crop || !image) return;
    const box = normalised(crop);
    if (box.width < 8 || box.height < 8) return;

    const origin = cropped ?? { x: 0, y: 0, width: image.width, height: image.height };
    setCropped({
      x: Math.max(0, Math.round(box.x)),
      y: Math.max(0, Math.round(box.y)),
      width: Math.min(Math.round(box.width), origin.width),
      height: Math.min(Math.round(box.height), origin.height),
    });
    setCrop(null);
    setTool('pen');
  }

  function reset() {
    setShapes([]);
    setApplied(0);
    setDraft(null);
    setCrop(null);
    setCropped(null);
  }

  /**
   * Flattens everything onto one canvas and hands it back as a file.
   *
   * Drawn at full image resolution, not at the size on screen: a markup of a
   * 2560px screenshot that came back 800px wide would be useless.
   */
  async function save() {
    if (!image) return;
    setSaving(true);

    try {
      const frame = cropped ?? { x: 0, y: 0, width: image.width, height: image.height };
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;

      const context = canvas.getContext('2d');
      if (!context) throw new Error('No canvas to flatten onto.');

      context.drawImage(
        image,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        0,
        0,
        frame.width,
        frame.height,
      );
      context.translate(-frame.x, -frame.y);

      /*
       * The blur is done on the pixels, not drawn as a shape: a translucent
       * rectangle over a password still has the password underneath it, and
       * the flattened file is what gets uploaded.
       */
      for (const shape of visible) {
        if (shape.kind !== 'blur') continue;

        const x = Math.max(0, Math.round(shape.x - frame.x));
        const y = Math.max(0, Math.round(shape.y - frame.y));
        const width = Math.min(Math.round(shape.width), canvas.width - x);
        const height = Math.min(Math.round(shape.height), canvas.height - y);
        if (width < 1 || height < 1) continue;

        const region = context.getImageData(x, y, width, height);
        pixelateRegion(
          region.data,
          { width, height },
          { x: 0, y: 0, width, height },
          Math.max(6, Math.round(Math.min(width, height) / 8)),
        );
        context.putImageData(region, x, y);
      }

      for (const shape of visible) {
        context.strokeStyle = shape.kind === 'blur' ? 'transparent' : shape.color;
        context.fillStyle = shape.color;
        context.lineJoin = 'round';
        context.lineCap = 'round';

        if (shape.kind === 'pen') {
          context.lineWidth = shape.width;
          context.beginPath();
          for (let i = 0; i < shape.points.length; i += 2) {
            const px = shape.points[i] as number;
            const py = shape.points[i + 1] as number;
            if (i === 0) context.moveTo(px, py);
            else context.lineTo(px, py);
          }
          context.stroke();
        } else if (shape.kind === 'arrow') {
          context.lineWidth = shape.width;
          const points = arrowPoints(shape);
          context.beginPath();
          context.moveTo(points[0] as number, points[1] as number);
          for (let i = 2; i < points.length; i += 2) {
            context.lineTo(points[i] as number, points[i + 1] as number);
          }
          context.stroke();
        } else if (shape.kind === 'rect') {
          context.lineWidth = shape.strokeWidth;
          context.strokeRect(shape.x, shape.y, shape.width, shape.height);
        } else if (shape.kind === 'ellipse') {
          context.lineWidth = shape.strokeWidth;
          context.beginPath();
          context.ellipse(
            shape.x + shape.width / 2,
            shape.y + shape.height / 2,
            shape.width / 2,
            shape.height / 2,
            0,
            0,
            Math.PI * 2,
          );
          context.stroke();
        } else if (shape.kind === 'text') {
          context.font =
            '600 ' + String(shape.fontSize) + 'px ui-sans-serif, system-ui, sans-serif';
          context.textBaseline = 'top';
          context.fillText(shape.text, shape.x, shape.y);
        }
      }

      context.setTransform(1, 0, 0, 1, 0, 0);
      onSave(await canvasToUpload(canvas, file.name, file.type));
    } finally {
      setSaving(false);
    }
  }

  const shapeNodes = [...visible, ...(draft ? [draft] : [])].map((shape, index) => {
    const key = 'shape-' + String(index);

    if (shape.kind === 'pen') {
      return (
        <Line
          key={key}
          points={shape.points}
          stroke={shape.color}
          strokeWidth={shape.width}
          lineCap="round"
          lineJoin="round"
          tension={0.3}
        />
      );
    }
    if (shape.kind === 'arrow') {
      return (
        <Line
          key={key}
          points={arrowPoints(shape)}
          stroke={shape.color}
          strokeWidth={shape.width}
          lineCap="round"
        />
      );
    }
    if (shape.kind === 'ellipse') {
      return (
        <Line
          key={key}
          points={ellipsePoints(shape)}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
          closed
        />
      );
    }
    if (shape.kind === 'blur') {
      /*
       * On screen the blurred area is shown as a hatched block: it says what
       * will happen without the cost of pixelating on every pointer move. The
       * real pixelation happens once, on save.
       */
      return (
        <Rect
          key={key}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          fill={MARKUP_CHROME.blurFill}
          opacity={0.92}
          stroke={MARKUP_CHROME.blurEdge}
          strokeWidth={1}
          dash={[6, 4]}
        />
      );
    }
    if (shape.kind === 'rect') {
      return (
        <Rect
          key={key}
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          stroke={shape.color}
          strokeWidth={shape.strokeWidth}
        />
      );
    }
    return (
      <KonvaText
        key={key}
        x={shape.x}
        y={shape.y}
        text={shape.text}
        fill={shape.color}
        fontSize={shape.fontSize}
        fontStyle="600"
      />
    );
  });

  const origin = cropped ?? { x: 0, y: 0 };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3">
      <Card
        role="dialog"
        aria-modal="true"
        aria-label="Mark up the image"
        className="flex max-h-full w-full max-w-4xl flex-col gap-3 p-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Mark up</h2>
          <p className="truncate text-xs text-ink-faint">{file.name}</p>
        </div>

        {/* ------------------------------------------------------ the toolbar */}
        <div
          role="toolbar"
          aria-label="Markup tools"
          aria-orientation="horizontal"
          className="flex flex-wrap items-center gap-1.5 rounded-lg bg-surface-muted p-1.5"
        >
          {TOOLS.map(({ tool: each, label, icon: Icon }) => (
            <button
              key={each}
              type="button"
              aria-label={label}
              aria-pressed={tool === each}
              title={label}
              onClick={() => setTool(each)}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                tool === each ? 'bg-accent text-on-accent' : 'text-ink-muted hover:bg-surface',
              )}
            >
              <Icon size={15} aria-hidden />
            </button>
          ))}

          <span className="mx-1 h-6 w-px bg-border-subtle" aria-hidden />

          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Colour</legend>
            {MARKUP_COLORS.map((each) => (
              <button
                key={each}
                type="button"
                aria-label={'Colour ' + each}
                aria-pressed={color === each}
                onClick={() => setColor(each)}
                style={{ background: each }}
                className={cn(
                  'h-7 w-7 rounded-full focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                  color === each ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface-muted' : '',
                )}
              />
            ))}
          </fieldset>

          <span className="mx-1 h-6 w-px bg-border-subtle" aria-hidden />

          <fieldset className="flex items-center gap-1">
            <legend className="sr-only">Thickness</legend>
            {MARKUP_SIZES.map((each, index) => (
              <button
                key={each}
                type="button"
                aria-label={['Thin', 'Medium', 'Thick'][index] + ' stroke'}
                aria-pressed={size === each}
                onClick={() => setSize(each)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
                  size === each ? 'bg-accent text-on-accent' : 'text-ink-muted hover:bg-surface',
                )}
              >
                <Minus size={10 + index * 4} strokeWidth={1 + index * 1.5} aria-hidden />
              </button>
            ))}
          </fieldset>

          <span className="mx-1 h-6 w-px bg-border-subtle" aria-hidden />

          <Button
            variant="ghost"
            size="sm"
            aria-label="Undo"
            disabled={applied === 0}
            onClick={() => setApplied((at) => Math.max(0, at - 1))}
          >
            <Undo2 size={14} aria-hidden /> Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Redo"
            disabled={applied >= shapes.length}
            onClick={() => setApplied((at) => Math.min(shapes.length, at + 1))}
          >
            <Redo2 size={14} aria-hidden /> Redo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Reset"
            disabled={shapes.length === 0 && !cropped}
            onClick={reset}
          >
            <RotateCcw size={14} aria-hidden /> Reset
          </Button>

          {tool === 'crop' ? (
            <Button variant="outline" size="sm" onClick={applyCrop} disabled={!crop}>
              Apply crop
            </Button>
          ) : null}
        </div>

        {/* -------------------------------------------------------- the canvas */}
        <div
          ref={boxRef}
          data-testid="markup-canvas"
          className="min-h-0 flex-1 overflow-auto rounded-lg bg-canvas p-2"
        >
          {image ? (
            <Stage
              ref={stageRef}
              width={view.width}
              height={view.height}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onWheel={onWheel}
              // Konva draws into one canvas, so the touch-action has to be
              // off the element or a drag scrolls the page instead of drawing.
              style={{ touchAction: 'none', margin: '0 auto' }}
            >
              <Layer
                scaleX={view.scale}
                scaleY={view.scale}
                x={-origin.x * view.scale}
                y={-origin.y * view.scale}
              >
                <KonvaImage image={image} />
                {shapeNodes}
                {crop ? (
                  <Rect
                    x={crop.x}
                    y={crop.y}
                    width={crop.width}
                    height={crop.height}
                    stroke={MARKUP_CHROME.cropOutline}
                    strokeWidth={2 / view.scale}
                    dash={[8 / view.scale, 6 / view.scale]}
                  />
                ) : null}
              </Layer>
            </Stage>
          ) : (
            <p className="p-6 text-center text-sm text-ink-faint">Opening the image…</p>
          )}
        </div>

        <p className="text-xs text-ink-faint">
          {tool === 'crop'
            ? 'Drag the part to keep, then Apply crop.'
            : tool === 'blur'
              ? 'Drag over anything that should not be readable. It is pixelated in the saved file, not covered over.'
              : 'Ctrl+Z undoes. Ctrl and the wheel, or two fingers, zooms.'}
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !image}>
            {saving ? 'Saving…' : 'Save markup'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
