/**
 * 4.0.0 moved every setting and command from `aidlc.*` to `aidlcNative.*` so
 * this build can sit next to the upstream AIDLC extension. The manifest must
 * not contribute a single id in the old namespace (that is the whole point),
 * and the settings copy must never overwrite a value the user set on purpose.
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  contributedSettingKeys,
  planSettingsMigration,
  type InspectedValues,
} from '../src/v2/settingsMigrationPlan';

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

describe('namespace', () => {
  it('contributes nothing under the upstream aidlc.* ids', () => {
    const c = pkg.contributes;
    const ids = [
      ...c.commands.map((x: { command: string }) => x.command),
      ...Object.keys(c.configuration.properties),
      ...c.viewsContainers.activitybar.map((x: { id: string }) => x.id),
      ...Object.values(c.views).flat().map((x) => (x as { id: string }).id),
    ];
    expect(ids.filter((id) => !id.startsWith('aidlcNative'))).toEqual([]);
    expect(pkg.displayName).toBe('AIDLC Native');
  });

  it('registers no command in source under the old namespace', () => {
    const src = path.join(__dirname, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(f.name)) {
          const text = fs.readFileSync(p, 'utf8');
          for (const m of text.matchAll(/(?:registerCommand|executeCommand)\(\s*['"`](aidlc\.[\w.]+)/g)) {
            offenders.push(`${path.relative(src, p)}: ${m[1]}`);
          }
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe('settings migration plan', () => {
  const store = (entries: Record<string, InspectedValues>) => (k: string) => entries[k];

  it('lists every contributed setting without its prefix', () => {
    const keys = contributedSettingKeys(pkg);
    expect(keys).toContain('claude.configDir');
    expect(keys).toContain('astGraph.engine');
    expect(keys.some((k) => k.startsWith('aidlcNative.'))).toBe(false);
  });

  it('copies a legacy value only where the new key is unset', () => {
    const moves = planSettingsMigration(
      ['claude.configDir', 'astGraph.engine', 'autopilot.enabled'],
      ['global', 'workspace'],
      store({
        'aidlc.claude.configDir': { globalValue: '~/.claude-personal', workspaceValue: '~/.claude-work' },
        'aidlcNative.claude.configDir': { workspaceValue: '~/.claude-new' },
        'aidlc.astGraph.engine': { workspaceValue: 'codegraph' },
      }),
    );
    expect(moves).toEqual([
      { key: 'claude.configDir', level: 'global', value: '~/.claude-personal' },
      { key: 'astGraph.engine', level: 'workspace', value: 'codegraph' },
    ]);
  });

  it('keeps falsy values — false and 0 are real choices', () => {
    const moves = planSettingsMigration(
      ['astGraph.enabled'],
      ['global'],
      store({ 'aidlc.astGraph.enabled': { globalValue: false } }),
    );
    expect(moves).toEqual([{ key: 'astGraph.enabled', level: 'global', value: false }]);
  });

  it('is a no-op once the copy has landed', () => {
    const entries = {
      'aidlc.astGraph.engine': { globalValue: 'codegraph' },
      'aidlcNative.astGraph.engine': { globalValue: 'codegraph' },
    };
    expect(planSettingsMigration(['astGraph.engine'], ['global'], store(entries))).toEqual([]);
  });
});
