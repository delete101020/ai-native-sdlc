import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, ModalFooter, ModalCancelButton, ModalConfirmButton } from './Modal';

interface Props {
  agent: string;
  runId: string;
  stepIdx: number;
  /**
   * Finished steps downstream that will be KEPT and marked dirty, by label.
   * Named rather than counted: this modal's only real job is to be told apart
   * from "Request update", and the difference is exactly which work survives.
   */
  keptSteps: string[];
  /** The confirm button's words — "Rerun with Claude" when it also launches the agent. */
  confirmLabel?: string;
  onSubmit: (feedback: string) => void;
  onClose: () => void;
}

export function RerunStepModal({
  agent,
  runId,
  stepIdx,
  keptSteps,
  confirmLabel = 'Rerun step',
  onSubmit,
  onClose,
}: Props) {
  const [feedback, setFeedback] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Optional, unlike Request update's: the common case here is "I edited the
  // prompt, run it again", and there is nothing to write that the prompt does
  // not already say.
  const submit = () => {
    onSubmit(feedback.trim());
    onClose();
  };

  return (
    <Modal
      title={`Rerun step ${stepIdx + 1}`}
      subtitle={
        <>
          <span className="font-mono text-foreground/80">{agent}</span> · run{' '}
          <span className="font-mono text-foreground/80">{runId}</span>
        </>
      }
      onClose={onClose}
      onSubmit={submit}
    >
      <div className="mb-3 rounded-md border border-border bg-secondary/20 px-2.5 py-2 text-[11px] text-muted-foreground">
        <div className="font-semibold text-foreground/85">
          This step reopens at revision++ and its artifacts are regenerated.
        </div>
        {keptSteps.length > 0 ? (
          <div className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2">
            <div className="flex items-center gap-1.5 font-semibold text-warning">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {keptSteps.length} finished step{keptSteps.length === 1 ? '' : 's'} after this one
              {keptSteps.length === 1 ? ' was' : ' were'} built on its current output
            </div>
            <ul className="mt-1 space-y-0.5">
              {keptSteps.map((label) => (
                <li key={label} className="font-mono text-[10.5px] text-foreground/75">
                  • {label}
                </li>
              ))}
            </ul>
            <div className="mt-1.5">
              {keptSteps.length === 1 ? 'It is' : 'They are'}{' '}
              <span className="font-semibold text-foreground/85">kept</span>, not reset — still done,
              but marked <span className="font-semibold text-warning">dirty</span> until redone
              against the new output. Nothing is blocked; you will be warned before working
              anything behind them.
            </div>
          </div>
        ) : (
          <div className="mt-1">Nothing finished downstream, so nothing will be marked dirty.</div>
        )}
        <div className="mt-1.5 text-muted-foreground/80">
          Need the downstream work redone from scratch instead? Use{' '}
          <span className="font-semibold">Request update</span>.
        </div>
      </div>

      <label className="mb-1 block text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
        What changed? <span className="font-normal normal-case tracking-normal">(optional)</span>
      </label>
      <textarea
        ref={ref}
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="e.g. updated the prompt to ask for the seal-cut edge cases"
        rows={3}
        className="w-full resize-none rounded-md border border-border bg-input/50 px-2.5 py-2 text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
      />

      <ModalFooter>
        <ModalCancelButton onClick={onClose} />
        <ModalConfirmButton onClick={submit} label={confirmLabel} />
      </ModalFooter>
    </Modal>
  );
}
