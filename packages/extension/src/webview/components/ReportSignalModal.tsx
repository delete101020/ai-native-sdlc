import { useMemo, useState } from 'react';
import { AlertTriangle, Radio } from 'lucide-react';
import { Modal, ModalFooter, ModalCancelButton, ModalConfirmButton } from './Modal';
import { postMessage } from '@/lib/bridge';
import { previewIncidentEpicId } from '@/lib/incidentId';

/**
 * Stage 6's front door.
 *
 * `native-incident` is the only recipe that reads an input the Start-Epic modal
 * cannot produce: `signal.json`. Starting it from there scaffolds an epic the
 * Operator then diagnoses with nothing to read, and the skill's own rule ("if
 * neither exists, write an incident.md that says so and stop") turns that into a
 * green run whose artifact is one line of apology. So the signal gets a form of
 * its own rather than a JSON file the user is expected to hand-write.
 *
 * The five fields are the schema in `@aidlc/core` — `Signal` — and they are the
 * whole contract: a person filling this in, a Sentry webhook and an OTel rule
 * all produce the same shape, which is what makes two incidents comparable
 * months apart.
 */

/** Sources with a known meaning. The field stays free text — new sources are adapters, not schema changes. */
const SOURCES = ['manual', 'sentry', 'otel', 'pager'];

export interface ReportSignalDraft {
  source: string;
  observedAt: string;
  symptom: string;
  scope: string;
  evidence: string;
  epicId: string;
}

/** `<input type="datetime-local">` wants local wall-clock with no zone. */
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ReportSignalModal({
  existingEpicIds,
  onClose,
}: {
  existingEpicIds: string[];
  onClose: () => void;
}) {
  const [source, setSource] = useState('manual');
  const [observedAt, setObservedAt] = useState(() => toLocalInputValue(new Date()));
  const [symptom, setSymptom] = useState('');
  const [scope, setScope] = useState('');
  const [evidence, setEvidence] = useState('');
  const [epicId, setEpicId] = useState('');

  const derivedId = useMemo(() => previewIncidentEpicId(symptom), [symptom]);
  const effectiveId = epicId.trim() || derivedId;

  const error = useMemo(() => {
    if (!source.trim()) { return 'Source is required'; }
    if (!observedAt.trim()) { return 'Observed at is required'; }
    if (!symptom.trim()) { return 'Symptom is required'; }
    if (!scope.trim()) { return 'Scope is required'; }
    if (epicId.trim() && !/^[A-Z][A-Z0-9-]*$/.test(epicId.trim())) {
      return 'Uppercase letters / digits / dashes only — must start with a letter';
    }
    if (epicId.trim() && existingEpicIds.includes(epicId.trim())) {
      return `Epic "${epicId.trim()}" already exists`;
    }
    return null;
  }, [source, observedAt, symptom, scope, epicId, existingEpicIds]);

  const submit = () => {
    if (error) { return; }
    const draft: ReportSignalDraft = {
      source: source.trim(),
      // Local wall-clock in, ISO-8601 out: the schema wants an instant, and a
      // string with no zone is not one.
      observedAt: new Date(observedAt).toISOString(),
      symptom: symptom.trim(),
      scope: scope.trim(),
      evidence: evidence.trim(),
      epicId: epicId.trim(),
    };
    postMessage({ type: 'reportSignal', draft });
    onClose();
  };

  return (
    <Modal
      title="Report a signal"
      subtitle="Something went wrong in production. This opens an incident epic that diagnoses it — it does not fix anything."
      maxWidth="max-w-xl"
      onClose={onClose}
      onSubmit={submit}
      closeOnBackdrop={false}
    >
      <div className="space-y-4">
        <div>
          <Label>Source</Label>
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={
                  source === s
                    ? 'rounded-full border border-primary/50 bg-primary/15 px-2.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary'
                    : 'rounded-full border border-border px-2.5 py-0.5 font-mono text-[10.5px] text-muted-foreground hover:bg-accent hover:text-foreground'
                }
              >
                {s}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            spellCheck={false}
            placeholder="manual"
            className={INPUT}
          />
          <Hint>Where the news came from. Free text — a new source is an adapter, not a schema change.</Hint>
        </div>

        <div>
          <Label>Observed at</Label>
          <input
            type="datetime-local"
            value={observedAt}
            onChange={(e) => setObservedAt(e.target.value)}
            className={INPUT}
          />
          <Hint>When it was <em>seen</em> — not when it was reported, and not now.</Hint>
        </div>

        <div>
          <Label>Symptom</Label>
          <input
            type="text"
            value={symptom}
            autoFocus
            onChange={(e) => setSymptom(e.target.value)}
            placeholder="e.g. Checkout returns 500 for repeat customers"
            className={INPUT}
          />
          <Hint>
            One line, <strong className="text-foreground">as observed, never as diagnosed</strong>. The moment this
            names a cause, stage 6 has nothing left to find out.
          </Hint>
        </div>

        <div>
          <Label>Scope</Label>
          <input
            type="text"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="e.g. ~40 orders/hour, EU tenants only, since the 14:20 deploy"
            className={INPUT}
          />
          <Hint>Who and what is affected, and how much.</Hint>
        </div>

        <div>
          <Label>
            Evidence <span className="font-normal normal-case tracking-normal text-muted-foreground/80">(optional)</span>
          </Label>
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            rows={5}
            placeholder="Stack trace, log excerpt, metric window, request id…"
            className={`${INPUT} resize-y font-mono text-[11px]`}
          />
          <Hint>Leave it empty rather than filling it in from memory — “no data yet” is an honest answer, an invented line is not.</Hint>
        </div>

        <div>
          <Label>
            Epic id <span className="font-normal normal-case tracking-normal text-muted-foreground/80">(optional)</span>
          </Label>
          <input
            type="text"
            value={epicId}
            onChange={(e) => setEpicId(e.target.value)}
            placeholder={derivedId}
            spellCheck={false}
            className={`${INPUT} font-mono`}
          />
          <Hint>
            Derived from the symptom when blank — <code className="font-mono text-foreground">{effectiveId}</code>. The
            host resolves collisions against the epics on disk.
          </Hint>
        </div>

        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-[10.5px] leading-relaxed text-muted-foreground">
          <Radio className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            The incident epic runs <code className="font-mono text-foreground">native-incident</code> — one unattended{' '}
            <code className="font-mono text-foreground">maintain</code> step that writes{' '}
            <code className="font-mono text-foreground">incident.md</code>. It diagnoses and hands forward; it never
            repairs. The fix, if there is one, becomes a follow-up epic that starts at stage 1 with a human gate.
          </span>
        </div>

        {error && symptom.trim() !== '' && (
          <div className="flex items-center gap-1.5 text-[10.5px] text-destructive">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            {error}
          </div>
        )}
      </div>

      <ModalFooter>
        <ModalCancelButton onClick={onClose} />
        <ModalConfirmButton onClick={submit} label="Open incident epic" disabled={!!error} />
      </ModalFooter>
    </Modal>
  );
}

const INPUT =
  'w-full rounded-md border border-border bg-input/50 px-2.5 py-2 text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
      {children}
    </label>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{children}</div>;
}
