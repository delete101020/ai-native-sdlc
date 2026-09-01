/**
 * The Claude-account switcher only exists to the user if it is *contributed*.
 * A command registered in code but missing from `contributes.commands` never
 * appears in the palette, and a setting missing from
 * `contributes.configuration` never appears in the Settings UI — both fail
 * silently, and the second one is exactly how a user ends up asking "where do
 * I paste the path?". These assertions are cheap and catch that drift.
 */
import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
) as {
  contributes: {
    commands: Array<{ command: string; title: string; category?: string }>;
    configuration: { properties: Record<string, { type: string; scope?: string }> };
  };
};

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'v2', 'claudeAccounts.ts'),
  'utf8',
);

describe('claude account switcher contributions', () => {
  it('contributes the switch command to the palette', () => {
    const cmd = pkg.contributes.commands.find((c) => c.command === 'aidlc.switchClaudeAccount');
    expect(cmd).toBeDefined();
    expect(cmd?.category).toBe('AIDLC');
    expect(source).toContain("'aidlc.switchClaudeAccount'");
  });

  it('contributes both settings, per-resource so windows can differ', () => {
    // `scope: resource` is what lets three windows hold three accounts at once;
    // demoting either to window/application scope silently breaks that.
    for (const key of ['aidlc.claude.configDir', 'aidlc.claude.configDirs']) {
      const prop = pkg.contributes.configuration.properties[key];
      expect(prop, key).toBeDefined();
      expect(prop.scope, key).toBe('resource');
      expect(source).toContain(`'${key}'`);
    }
  });

  it('describes saved accounts as {label?, path}', () => {
    const items = (pkg.contributes.configuration.properties['aidlc.claude.configDirs'] as {
      items?: { required?: string[]; properties?: Record<string, unknown> };
    }).items;
    expect(items?.required).toEqual(['path']);
    expect(Object.keys(items?.properties ?? {}).sort()).toEqual(['label', 'path']);
  });
});
