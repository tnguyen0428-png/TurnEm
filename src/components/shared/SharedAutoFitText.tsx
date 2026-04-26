import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Coordinated auto-fit text. Unlike `AutoFitText` which sizes each instance
 * independently (so a short name renders larger than a long one), this picks
 * a single font size that fits the longest registered text in its container,
 * and broadcasts that size to every member of the group.
 *
 * Wrap a list of cards with `<SharedAutoFitProvider>` and use
 * `<SharedAutoFitText>` inside each card. Every card's text re-fits in lockstep
 * as the grid resizes, so all names always render at the same size.
 */
interface GroupCtx {
  fontSize: number;
  register: (id: string, el: HTMLElement, text: string) => () => void;
}

const Ctx = createContext<GroupCtx | null>(null);

interface ProviderProps {
  children: ReactNode;
  /** Tailwind/utility class for the hidden measurement span. Should match the
   *  font-family / letter-spacing / weight of the visible text so the
   *  scrollWidth measurement matches. */
  measureClassName?: string;
  minSize?: number;
  maxSize?: number;
}

export function SharedAutoFitProvider({
  children,
  measureClassName = '',
  minSize = 10,
  maxSize = 20,
}: ProviderProps) {
  const [fontSize, setFontSize] = useState(maxSize);
  const entriesRef = useRef<Map<string, { el: HTMLElement; text: string }>>(new Map());
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const rafRef = useRef<number | null>(null);

  const compute = useCallback(() => {
    rafRef.current = null;
    const span = measureRef.current;
    if (!span) return;
    const entries = Array.from(entriesRef.current.values());
    if (entries.length === 0) {
      setFontSize(maxSize);
      return;
    }
    let best = maxSize;
    for (const { text, el } of entries) {
      const w = el.clientWidth;
      if (w === 0) continue;
      span.textContent = text;
      // Binary search the largest size that fits this entry's width.
      let lo = minSize;
      let hi = maxSize;
      let fit = minSize;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        span.style.fontSize = `${mid}px`;
        if (span.scrollWidth <= w) {
          fit = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (fit < best) best = fit;
    }
    setFontSize(best);
  }, [minSize, maxSize]);

  const schedule = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(compute);
  }, [compute]);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(schedule);
    roRef.current = ro;
    // Pick up anything that registered before the observer existed.
    entriesRef.current.forEach(({ el }) => ro.observe(el));
    return () => {
      ro.disconnect();
      roRef.current = null;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [schedule]);

  // Re-fit when webfonts (e.g. Bebas Neue) finish loading — metrics shift
  // after the swap.
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts?.ready) return;
    let cancelled = false;
    document.fonts.ready.then(() => {
      if (!cancelled) schedule();
    });
    return () => {
      cancelled = true;
    };
  }, [schedule]);

  const register = useCallback(
    (id: string, el: HTMLElement, text: string) => {
      entriesRef.current.set(id, { el, text });
      roRef.current?.observe(el);
      schedule();
      return () => {
        entriesRef.current.delete(id);
        roRef.current?.unobserve(el);
        schedule();
      };
    },
    [schedule]
  );

  return (
    <Ctx.Provider value={{ fontSize, register }}>
      <span
        ref={measureRef}
        aria-hidden="true"
        className={`whitespace-nowrap ${measureClassName}`}
        style={{
          position: 'fixed',
          top: -9999,
          left: -9999,
          visibility: 'hidden',
          pointerEvents: 'none',
          fontSize: `${maxSize}px`,
        }}
      />
      {children}
    </Ctx.Provider>
  );
}

interface TextProps {
  children: string;
  className?: string;
}

export function SharedAutoFitText({ children, className = '' }: TextProps) {
  const ctx = useContext(Ctx);
  const containerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!ctx) return;
    const el = containerRef.current;
    if (!el) return;
    const id = Math.random().toString(36).slice(2);
    return ctx.register(id, el, children);
  }, [ctx, children]);

  const fontSize = ctx?.fontSize ?? 20;

  return (
    <div ref={containerRef} className={`min-w-0 overflow-hidden ${className}`}>
      <span className="block whitespace-nowrap" style={{ fontSize: `${fontSize}px` }}>
        {children}
      </span>
    </div>
  );
}
