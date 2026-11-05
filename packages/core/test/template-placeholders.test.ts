import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const TEMPLATES = path.resolve(__dirname, '../templates');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

function offenders(paths: string[], pattern: RegExp): string[] {
  return paths.flatMap((file) =>
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => pattern.test(line))
      .map((line) => `${path.relative(TEMPLATES, file)}: ${line}`),
  );
}

/**
 * The template renderer only resolves `{{#if}}`-style blocks; nothing fills in
 * a `{{NAME}}`, a `$EPIC_ID` or a `$DATE`. One written in a template reaches the agent
 * literally, which is how `docs/epics/{{EPIC_KEY}}/PRD.md` shipped. Write
 * `<epic-id>` instead.
 */
describe('bundled templates', () => {
  it('contain no placeholders that nothing would fill in', () => {
    expect(offenders(files(TEMPLATES), /\{\{[A-Z_]+\}\}|\$\{?(EPIC_(ID|KEY)|DATE)\b/)).toEqual([]);
  });

  it('keep slash-command arguments out of agent files', () => {
    // Agent files also install as standalone subagents, where a command's `$0`
    // or `$ARGUMENTS` is never substituted.
    const agents = files(TEMPLATES).filter((f) => path.basename(path.dirname(f)) === 'agents');
    expect(agents.length).toBeGreaterThan(0);
    expect(offenders(agents, /\$(\d|ARGUMENTS\b)/)).toEqual([]);
  });
});
