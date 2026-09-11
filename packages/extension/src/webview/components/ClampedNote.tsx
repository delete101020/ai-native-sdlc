import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * A reject reason or carried feedback, clamped to three lines.
 *
 * Feedback is free text typed into the Reject modal and can run to forty
 * lines of findings; rendered whole it pushed a run's step controls off the
 * card. The clamp keeps the card its usual height, the toggle shows the rest
 * in place, and line breaks survive either way so a numbered list stays one.
 */
export function ClampedNote({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) { return; }
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    // The card width follows the sidebar, so the same text can start or stop
    // overflowing when the panel is resized.
    if (typeof ResizeObserver === 'undefined') { return; }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div className={className}>
      <div
        ref={ref}
        className={cn(
          'whitespace-pre-line break-words',
          expanded ? 'max-h-64 overflow-y-auto' : 'line-clamp-3',
        )}
      >
        {text.trim()}
      </div>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 font-sans text-[9.5px] font-medium opacity-80 underline-offset-2 hover:underline hover:opacity-100"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
