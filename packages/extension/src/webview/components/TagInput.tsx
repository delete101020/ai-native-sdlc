import { useMemo, useRef, useState } from 'react';
import { Tag as TagIcon, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { normalizeTag, normalizeTags } from '@/lib/tags';

/**
 * Free-text tag entry that shows the user what the store will actually keep.
 *
 * Tags are typed however the person thinks of them and stored in one canonical
 * uppercase form (`thanh toán vnpay` → `THANH-TOAN-VNPAY`), which is the whole
 * reason filtering by them works. That transformation is invisible unless
 * something shows it, so this does, twice: the committed chips are the stored
 * form, and the half-typed word carries a live preview underneath as soon as it
 * would be stored differently from how it reads.
 *
 * Commit keys are Enter, comma and Tab — the three every tag field has taught
 * people to expect. Backspace on an empty box takes the last chip back, so
 * correcting a typo does not need the mouse.
 */
export function TagInput({
  tags,
  onChange,
  suggestions = [],
  placeholder = 'payment, release-q3, tech debt…',
  autoFocus = false,
  disabled = false,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  /** Tags already in use elsewhere, offered as one-click chips. */
  suggestions?: string[];
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const preview = normalizeTag(draft);
  // Only worth showing when the fold actually changed something — echoing
  // "PAYMENT" under a box that says "PAYMENT" is noise.
  const showPreview = draft.trim().length > 0 && preview !== draft.trim();

  const commit = (raw: string) => {
    const next = normalizeTags([...tags, ...raw.split(',')]);
    if (next.length !== tags.length || next.some((t, i) => t !== tags[i])) { onChange(next); }
    setDraft('');
  };

  const remove = (tag: string) => onChange(tags.filter((t) => t !== tag));

  const unused = useMemo(
    () => normalizeTags(suggestions).filter((s) => !tags.includes(s)).slice(0, 12),
    [suggestions, tags],
  );

  return (
    <div className="space-y-1.5">
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-input/50 px-2 py-1.5',
          'focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/40',
          disabled && 'opacity-50',
        )}
      >
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-wide text-primary"
          >
            {tag}
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); remove(tag); }}
              title={`Remove ${tag}`}
              className="rounded-full text-primary/70 hover:text-primary"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          value={draft}
          autoFocus={autoFocus}
          disabled={disabled}
          placeholder={tags.length === 0 ? placeholder : ''}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
              if (!draft.trim()) { return; }
              // Enter inside a modal would otherwise submit the whole form —
              // here it means "that is one tag, give me the next box".
              e.preventDefault();
              commit(draft);
              return;
            }
            if (e.key === 'Backspace' && !draft && tags.length > 0) {
              e.preventDefault();
              remove(tags[tags.length - 1]);
            }
          }}
          // A tag left half-typed when focus moves on is still a tag the user
          // meant — losing it to a misplaced click is the classic bug here.
          onBlur={() => { if (draft.trim()) { commit(draft); } }}
          className="min-w-[8rem] flex-1 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
        />
      </div>

      {showPreview && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <TagIcon className="h-2.5 w-2.5 shrink-0" />
          <span>
            Stored as <span className="font-mono font-semibold text-primary">{preview || '—'}</span>
            {!preview && ' (nothing filterable in that — it will be dropped)'}
          </span>
        </div>
      )}

      {unused.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-muted-foreground">In use:</span>
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              disabled={disabled}
              onClick={() => onChange(normalizeTags([...tags, s]))}
              title={`Add ${s}`}
              className="rounded-full border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/40 hover:text-primary"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
