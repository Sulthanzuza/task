import { useCallback, useEffect, type RefObject } from 'react';

/**
 * A textarea that grows with what is typed in it.
 *
 * Three lines is enough for "looks good, merging", and a comment that is
 * really a handover should not be written through a three-line window. So the
 * box grows, up to a share of the viewport, and scrolls after that: past
 * roughly half the screen the box has stopped being a box and the thing you
 * are replying to has gone.
 *
 * Measured from scrollHeight, which needs the height reset first — otherwise
 * the box only ever grows, because scrollHeight can never report less than
 * the height already set.
 */
export const AUTO_GROW_MAX_VIEWPORT_FRACTION = 0.4;

export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  minRows = 3,
): () => void {
  const resize = useCallback(() => {
    const node = ref.current;
    if (!node) return;

    const styles = window.getComputedStyle(node);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const padding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom) || 0;
    const border =
      Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth) || 0;

    const min = lineHeight * minRows + padding + border;
    const max = window.innerHeight * AUTO_GROW_MAX_VIEWPORT_FRACTION;

    // Reset before measuring, or the box can only ever get taller.
    node.style.height = 'auto';
    const wanted = node.scrollHeight + border;

    const height = Math.max(min, Math.min(wanted, max));
    node.style.height = height + 'px';
    // Scrolls only once it has stopped growing, so there is never both.
    node.style.overflowY = wanted > max ? 'auto' : 'hidden';
  }, [ref, minRows]);

  // On every change, including one made by code rather than by typing: the
  // box has to shrink back when a comment is sent and the value is cleared.
  useEffect(resize, [resize, value]);

  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [resize]);

  return resize;
}
