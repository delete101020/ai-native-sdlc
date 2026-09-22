import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { setEpicDescription, EpicDescriptionError } from '../src';

function epic(state: Record<string, unknown>, doc?: string): { dir: string; id: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-desc-'));
  const id = String(state.id ?? 'CR-1');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  if (doc !== undefined) { fs.writeFileSync(path.join(dir, `${id}.md`), doc, 'utf8'); }
  return { dir, id };
}

function readState(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
}

describe('setEpicDescription', () => {
  it('rewrites state.json without touching the mirrored run', () => {
    const { dir, id } = epic({
      id: 'CR-1', title: 'Checkout', description: 'old one-liner', status: 'in_progress',
      stepStates: [{ agent: 'po', status: 'done' }],
    });

    const edit = setEpicDescription(dir, id, '  new one-liner  ');

    expect(edit.description).toBe('new one-liner');
    expect(edit.previous).toBe('old one-liner');
    const state = readState(dir);
    expect(state.description).toBe('new one-liner');
    // Everything else survives — this is a read-modify-write, not a rewrite.
    expect(state.status).toBe('in_progress');
    expect(state.stepStates).toEqual([{ agent: 'po', status: 'done' }]);
  });

  it('moves the markdown brief too, since that is what agents read', () => {
    const { dir, id } = epic(
      { id: 'CR-1', title: 'Checkout', description: 'old one-liner' },
      '# CR-1 — Checkout\n\nold one-liner\n',
    );

    const edit = setEpicDescription(dir, id, 'new one-liner');

    expect(edit.doc).toBe('updated');
    expect(fs.readFileSync(path.join(dir, 'CR-1.md'), 'utf8'))
      .toBe('# CR-1 — Checkout\n\nnew one-liner\n');
  });

  it('keeps sections an agent appended below the lead', () => {
    const { dir, id } = epic(
      { id: 'CR-1', title: 'Checkout', description: 'old one-liner' },
      '# CR-1 — Checkout\n\nold one-liner\n\n## Intent\n\nwritten by the spec phase\n',
    );

    expect(setEpicDescription(dir, id, 'new one-liner').doc).toBe('updated');
    const md = fs.readFileSync(path.join(dir, 'CR-1.md'), 'utf8');
    expect(md).toContain('new one-liner');
    expect(md).not.toContain('old one-liner');
    expect(md).toContain('## Intent\n\nwritten by the spec phase');
  });

  it('leaves a hand-written brief alone and says so', () => {
    const brief = '# CR-1 — Checkout\n\nThree paragraphs somebody actually wrote.\n\nSecond one.\n';
    const { dir, id } = epic({ id: 'CR-1', description: 'old one-liner' }, brief);

    const edit = setEpicDescription(dir, id, 'new one-liner');

    // state.json still moves — the user asked for that and it costs nothing.
    expect(readState(dir).description).toBe('new one-liner');
    expect(edit.doc).toBe('kept');
    expect(fs.readFileSync(path.join(dir, 'CR-1.md'), 'utf8')).toBe(brief);
  });

  it('writes the brief when the epic has none', () => {
    const { dir, id } = epic({ id: 'CR-1', title: 'Checkout', description: '' });

    expect(setEpicDescription(dir, id, 'first words').doc).toBe('created');
    expect(fs.readFileSync(path.join(dir, 'CR-1.md'), 'utf8'))
      .toBe('# CR-1 — Checkout\n\nfirst words\n');
  });

  it('reports an unchanged brief rather than rewriting the file', () => {
    const { dir, id } = epic(
      { id: 'CR-1', description: 'same words' },
      '# CR-1\n\nsame words\n',
    );
    expect(setEpicDescription(dir, id, 'same words').doc).toBe('unchanged');
  });

  it('clears the lead when the description is emptied', () => {
    const { dir, id } = epic(
      { id: 'CR-1', description: 'old one-liner' },
      '# CR-1\n\nold one-liner\n\n## Intent\n\nbody\n',
    );

    setEpicDescription(dir, id, '');

    expect(readState(dir).description).toBe('');
    expect(fs.readFileSync(path.join(dir, 'CR-1.md'), 'utf8')).toBe('# CR-1\n\n## Intent\n\nbody\n');
  });

  it('refuses an unreadable or corrupt state.json instead of writing a new one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-desc-'));
    expect(() => setEpicDescription(dir, 'CR-1', 'x')).toThrow(EpicDescriptionError);

    fs.writeFileSync(path.join(dir, 'state.json'), '{ not json', 'utf8');
    expect(() => setEpicDescription(dir, 'CR-1', 'x')).toThrow(/not valid JSON/);
  });
});
