import { useLayoutEffect, useRef } from 'react';

/**
 * Renders text that automatically scales its font-size to fit the available
 * width of its container. Uses a binary search over [minSize, maxSize] (in
 * pixels) and re-measures whenever the container resizes (ResizeObserver) or
 * the text content changes.
 *
 * The container itself is set to `min-w-0 overflow-hidden` so it can shrink
 * inside flex/grid layouts. Pass `flex-1` (or any sizing utility) via the
 * `className` prop to control how the container claims space in its parent.
 *
 * Font-family, color, letter-spacing, line-height are inherited from the
 * container — apply them via `className` like you would on a normal element.
 */
interface AutoFitTextProps {
  children: string;
  minSize?: number;
  maxSize?: number;
  className?: string;
}

export default function AutoFitText({
  children,
  minSize = 10,
  maxSize = 20,
  className = '',
}: AutoFitTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    function fit() {
      if (!container || !text) return;
      const containerWidth = container.clientWidth;
      if (containerWidth === 0) return;

      // Binary search the largest font size that fits the container width.
      let lo = minSize;
      let hi = maxSize;
      let best = minSize;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        text.style.fontSize = `${mid}px`;
        if (text.scrollWidth <= containerWidth) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      text.style.fontSize = `${best}px`;
    }

    fit();

    // Re-fit when the container resizes.
    const ro = new ResizeObserver(fit);
    ro.observe(container);

    // Re-fit once webfonts (e.g. Bebas Neue) finish loading, since metrics
    // change after the swap. document.fonts.ready resolves immediately if
    // fonts are already loaded.
    let cancelled = false;
    if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) fit();
      });
    }

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [children, minSize, maxSize]);

  return (
    <div ref={containerRef} className={`min-w-0 overflow-hidden ${className}`}>
      <span
        ref={textRef}
        className="block whitespace-nowrap"
        style={{ fontSize: `${maxSize}px` }}
      >
        {children}
      </span>
    </div>
  );
}
