import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The bridge between a webview button and the command that does the work.
 *
 * The bug these tests exist for: both panels built their run-gate command id
 * as `aidlc.${msg.type}`, but every command is contributed under
 * `aidlcNative.`. `executeCommand` rejected, the rejection was dropped on the
 * floor by an un-awaited async listener, and "Mark step done" did nothing at
 * all — no toast, no log — for the whole life of the pipeline runner.
 *
 * Both halves are asserted statically over the source, because neither half
 * can be caught by a unit test of the handler: the id is only wrong at the
 * moment VS Code looks it up.
 */
const SRC = path.resolve(__dirname, '..', 'src');
const WEBVIEW = path.join(SRC, 'webview');

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { out.push(...walk(p, match)); }
    else if (match.test(e.name)) { out.push(p); }
  }
  return out;
}

const tsFiles = walk(SRC, /\.tsx?$/);
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('command ids reachable from a webview', () => {
  it('executes only command ids that are registered', () => {
    const registered = new Set<string>();
    for (const f of tsFiles) {
      for (const m of read(f).matchAll(/registerCommand\(\s*['"`]([^'"`]+)['"`]/g)) {
        registered.add(m[1]);
      }
      // Ids held in a constant — `registerCommand(OPEN_COMMAND, …)`.
      for (const m of read(f).matchAll(/^const\s+\w+\s*=\s*'(aidlcNative\.[\w.]+)';/gm)) {
        registered.add(m[1]);
      }
    }
    const unknown: string[] = [];
    for (const f of tsFiles) {
      for (const m of read(f).matchAll(/executeCommand[^(]*\(\s*['"`](aidlc[^'"`]*)['"`]/g)) {
        if (!registered.has(m[1])) { unknown.push(`${path.relative(SRC, f)} → ${m[1]}`); }
      }
    }
    expect(unknown).toEqual([]);
  });

  it('never builds an own command id under the legacy `aidlc.` prefix', () => {
    // `aidlc.` survives as the *settings* prefix the migration reads from;
    // a command built that way resolves to nothing.
    const offenders: string[] = [];
    for (const f of tsFiles) {
      for (const m of read(f).matchAll(/`aidlc\.\$\{[^}]+\}`/g)) {
        if (/settingsMigration/.test(f)) { continue; }
        offenders.push(`${path.relative(SRC, f)} → ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('webview message types', () => {
  // Each React entrypoint is served by exactly one host.
  const HOSTS: Record<string, string> = {
    sidebar: 'v2/sidebarWebview.ts',
    workspace: 'v2/workspaceWebview.ts',
    monitor: 'v2/monitorWebview.ts',
    standard: 'v2/standardPickerWebview.ts',
    report: 'v2/tokenReportWebview.ts',
  };

  function reachable(entry: string): string[] {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const f = queue.pop()!;
      if (seen.has(f)) { continue; }
      seen.add(f);
      for (const m of read(f).matchAll(/from\s+'(\.[^']+)'/g)) {
        const base = path.resolve(path.dirname(f), m[1]);
        const hit = [base + '.tsx', base + '.ts', base + '/index.tsx', base + '/index.ts']
          .find((c) => fs.existsSync(c));
        if (hit) { queue.push(hit); }
      }
    }
    return [...seen];
  }

  for (const [entry, host] of Object.entries(HOSTS)) {
    it(`${entry}: every type it posts has a case in its host`, () => {
      const main = path.join(WEBVIEW, entry, 'main.tsx');
      const handled = new Set(
        [...read(path.join(SRC, host)).matchAll(/case\s+'([^']+)'\s*:/g)].map((m) => m[1]),
      );
      const unhandled: string[] = [];
      for (const f of reachable(main)) {
        for (const m of read(f).matchAll(/postMessage\(\s*\{\s*type:\s*'([^']+)'/g)) {
          if (!handled.has(m[1])) { unhandled.push(`${path.relative(WEBVIEW, f)} → ${m[1]}`); }
        }
      }
      expect(unhandled).toEqual([]);
    });
  }
});

describe('message handlers', () => {
  it('wraps every onDidReceiveMessage listener so a throw is surfaced', () => {
    const bare: string[] = [];
    for (const f of tsFiles) {
      const s = read(f);
      for (const m of s.matchAll(/onDidReceiveMessage\(\s*(?:\n\s*)?([^,)]+)/g)) {
        if (!/guardMessages/.test(m[1])) {
          bare.push(`${path.relative(SRC, f)} → ${m[1].trim()}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
