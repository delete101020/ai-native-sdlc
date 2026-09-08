import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, ModalFooter, ModalCancelButton, ModalConfirmButton } from './Modal';

interface Props {
  epicId: string;
  /** Path shown to the user (workspace-relative when available). */
  epicDir: string;
  /** Whether this epic has a live run-state JSON in .aidlc/runs/. */
  hasRun: boolean;
  /**
   * Artifact filenames present in the epic's `artifacts/` folder. Listed
   * verbatim rather than counted: "3 artifacts" is a number, `PRD.md`,
   * `design.md`, `implement-summary.md` is the work.
   */
  artifacts: string[];
  /** Steps already approved — the reviews that go with the artifacts. */
  doneSteps: number;
  onConfirm: (deleteFolder: boolean) => void;
  onClose: () => void;
}

/**
 * Confirm dialog for deleting an epic. By default only the live run-state JSON
 * is removed and the on-disk folder is kept — matching the historical
 * `deleteRun` behaviour. Ticking the checkbox opts into deleting the whole
 * `docs/epics/<id>` folder, which is irreversible, so that path additionally
 * requires the user to type the epic id to confirm.
 *
 * The checkbox names what it reaches by name. A dialog that says "and all
 * artifacts" is asking the user to remember what an epic they opened last week
 * contains; one that lists `PRD.md` and `design.md` is asking them to look at
 * it. Same click, different question.
 */
export function DeleteEpicModal({ epicId, epicDir, hasRun, artifacts, doneSteps, onConfirm, onClose }: Props) {
  const [deleteFolder, setDeleteFolder] = useState(false);
  const [typed, setTyped] = useState('');
  const canConfirm = !deleteFolder || typed.trim() === epicId;

  const submit = () => {
    if (!canConfirm) { return; }
    onConfirm(deleteFolder);
    onClose();
  };

  return (
    <Modal
      title={`Delete epic ${epicId}`}
      onClose={onClose}
      onSubmit={submit}
      closeOnBackdrop={false}
    >
      <div className="space-y-3 text-[12px] leading-relaxed text-foreground/85">
        <p>
          {hasRun
            ? 'This removes the live run-state JSON from .aidlc/runs/.'
            : 'This epic has no live run state.'}{' '}
          By default the epic folder and its artifacts are kept.
        </p>

        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-card/50 px-3 py-2">
          <input
            type="checkbox"
            checked={deleteFolder}
            onChange={(e) => { setDeleteFolder(e.target.checked); setTyped(''); }}
            className="mt-0.5 shrink-0"
          />
          <span>
            Also delete the folder{' '}
            <code className="break-all font-mono text-[11px] text-foreground">{epicDir}</code>{' '}
            — state, inputs, and every artifact.
          </span>
        </label>

        {deleteFolder && artifacts.length > 0 && (
          <div>
            <div className="mb-1 text-[10.5px] font-bold uppercase tracking-wider text-muted-foreground">
              Goes with it
            </div>
            <ul className="space-y-0.5 font-mono text-[11px] text-foreground/80">
              {artifacts.map((a) => <li key={a}>{a}</li>)}
            </ul>
            {doneSteps > 0 && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Plus the {doneSteps} approved step{doneSteps === 1 ? '' : 's'} behind them — the
                reviews, the rejections, and the feedback that produced these files.
              </p>
            )}
          </div>
        )}

        {deleteFolder && (
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3">
            <div className="flex items-center gap-1.5 font-semibold text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              This permanently deletes the folder and cannot be undone.
            </div>
            <p className="text-muted-foreground">
              Type <span className="font-mono font-semibold text-foreground">{epicId}</span> to confirm:
            </p>
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={epicId}
              className="w-full rounded-md border border-border bg-input/50 px-2.5 py-1.5 font-mono text-[12px] text-foreground placeholder:text-muted-foreground/70 focus:border-destructive focus:outline-none focus:ring-1 focus:ring-destructive/40"
            />
          </div>
        )}
      </div>

      <ModalFooter>
        <ModalCancelButton onClick={onClose} />
        <ModalConfirmButton
          onClick={submit}
          label={deleteFolder ? 'Delete epic + folder' : 'Delete run state'}
          danger
          disabled={!canConfirm}
        />
      </ModalFooter>
    </Modal>
  );
}
