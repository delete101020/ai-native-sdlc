/**
 * Path resolution for workspace.yaml-declared paths.
 *
 * The bug this guards: built-in presets write skill paths as
 * `~/.claude/skills/<file>.md`, and `path.resolve(root, declared)` treats `~`
 * as an ordinary directory name — producing `<root>/~/.claude/...`, which
 * never exists. `aidlc doctor` reported every globally installed skill as
 * missing because of it, while the loader (which did expand `~`) ran fine.
 */
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { expandHome, resolveDeclaredPath } from '../src/util/paths';

const HOME = '/home/tester';

describe('expandHome', () => {
  it('expands a leading ~/', () => {
    expect(expandHome('~/.claude/skills/a.md', HOME))
      .toBe(path.join(HOME, '.claude/skills/a.md'));
  });

  it('leaves relative and absolute paths alone', () => {
    expect(expandHome('./skills/a.md', HOME)).toBe('./skills/a.md');
    expect(expandHome('/etc/a.md', HOME)).toBe('/etc/a.md');
  });

  it('does not touch a bare ~ or a ~user form', () => {
    // Only `~/` is a home reference we can resolve; `~bob/` means bob's home,
    // which we deliberately do not try to look up.
    expect(expandHome('~', HOME)).toBe('~');
    expect(expandHome('~bob/x.md', HOME)).toBe('~bob/x.md');
  });

  it('defaults to the real home directory', () => {
    expect(expandHome('~/x.md')).toBe(path.join(os.homedir(), 'x.md'));
  });
});

describe('resolveDeclaredPath', () => {
  it('resolves a ~ path to the home directory, not under the workspace root', () => {
    const resolved = resolveDeclaredPath('/work/project', '~/.claude/skills/a.md', HOME);
    expect(resolved).toBe(path.join(HOME, '.claude/skills/a.md'));
    expect(resolved).not.toContain('/work/project');
    expect(resolved).not.toContain('~');
  });

  it('still resolves a relative path against the workspace root', () => {
    expect(resolveDeclaredPath('/work/project', './.aidlc/skills/a.md', HOME))
      .toBe('/work/project/.aidlc/skills/a.md');
  });

  it('leaves an absolute path absolute', () => {
    expect(resolveDeclaredPath('/work/project', '/opt/skills/a.md', HOME))
      .toBe('/opt/skills/a.md');
  });
});
