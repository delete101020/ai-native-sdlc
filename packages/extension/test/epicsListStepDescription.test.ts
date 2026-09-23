import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listEpics } from '../src/v2/epicsList';

/**
 * The step card says what the step does. Two steps on one agent must not
 * both show the agent's description, so the step's own `description` wins,
 * then the frontmatter description of the step's only skill; with neither,
 * nothing is sent and the card keeps showing the agent's.
 */
describe('listEpics — step description', () => {
  let root: string;
  const epicId = 'CR-1';

  const docWith = (steps: unknown[], skills: unknown[] = []) => ({
    state: { root: 'docs/epics' },
    slash_commands: [],
    skills,
    pipelines: [{ id: 'cr', steps }],
  } as unknown as Parameters<typeof listEpics>[1]);

  const command = (id: string, description: string) => {
    const dir = path.join(root, '.claude', 'commands');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\ndescription: "${description}"\n---\n\n# ${id}\n`);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-step-description-'));
    const epicDir = path.join(root, 'docs', 'epics', epicId);
    fs.mkdirSync(epicDir, { recursive: true });
    fs.writeFileSync(
      path.join(epicDir, 'state.json'),
      JSON.stringify({
        id: epicId,
        title: 'CR',
        pipeline: 'cr',
        currentStep: 0,
        status: 'in_progress',
        stepStates: [
          { agent: 'cr-dev', status: 'in_progress' },
          { agent: 'cr-dev', status: 'pending' },
        ],
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses the step description, over the skill', () => {
    command('cr-build-spec', 'Skill text');
    const [spec, build] = listEpics(root, docWith([
      { agent: 'cr-dev', name: 'cr-build-spec', skills: ['cr-build-spec'], description: 'Write the build spec.' },
      { agent: 'cr-dev', name: 'cr-build', description: 'Build against the spec.' },
    ]))[0].stepDetails;
    expect(spec.description).toBe('Write the build spec.');
    expect(build.description).toBe('Build against the spec.');
  });

  it('falls back to the frontmatter of the only skill, from .claude/commands', () => {
    command('cr-build-spec', 'Spec the build.');
    command('cr-build', 'Build it.');
    const [spec, build] = listEpics(root, docWith([
      { agent: 'cr-dev', name: 'cr-build-spec', skills: ['cr-build-spec'] },
      { agent: 'cr-dev', name: 'cr-build', skills: ['cr-build'] },
    ]))[0].stepDetails;
    expect(spec.description).toBe('Spec the build.');
    expect(build.description).toBe('Build it.');
  });

  it('reads the path workspace.yaml declares for the skill first', () => {
    command('cr-build', 'Command file text');
    const dir = path.join(root, 'skills');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'build.md'), '---\ndescription: Declared skill text\n---\n');
    const step = listEpics(root, docWith(
      [{ agent: 'cr-dev', skills: ['cr-build'] }, { agent: 'cr-dev' }],
      [{ id: 'cr-build', path: 'skills/build.md' }],
    ))[0].stepDetails[0];
    expect(step.description).toBe('Declared skill text');
  });

  it('leaves it to the agent when the step has several skills or none', () => {
    command('a', 'A');
    command('b', 'B');
    const [several, none] = listEpics(root, docWith([
      { agent: 'cr-dev', skills: ['a', 'b'] },
      { agent: 'cr-dev' },
    ]))[0].stepDetails;
    expect(several.description).toBeUndefined();
    expect(none.description).toBeUndefined();
  });
});
