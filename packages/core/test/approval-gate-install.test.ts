/**
 * Setting up a workspace used to leave the approval gate out: the script sat
 * in this repo only, and its registration in a gitignored settings file
 * nothing wrote. An autopilot pipeline then refused to start until the person
 * found ONBOARDING.md. These cover the installer that closes that gap.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { builtinTemplatesRoot, findApprovalGate, installApprovalGate } from '../src/index';

const CORE_ROOT = path.resolve(__dirname, '..');

let root: string;
let userDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-gate-install-'));
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-claude-home-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
});

const install = (python = 'python3') =>
  installApprovalGate(builtinTemplatesRoot(), root, { userConfigDir: userDir, python });
const settingsFile = (): string => path.join(root, '.claude', 'settings.local.json');

describe('installApprovalGate', () => {
  it('copies the script and registers it where autopilot preflight looks', () => {
    const r = install();
    expect(r.script).toBe(path.join(root, '.claude', 'hooks', 'aidlc-approval-gate.py'));
    expect(r.registered).toBe(settingsFile());
    expect(findApprovalGate(root, { userConfigDir: userDir })).toMatchObject({ found: true });
  });

  it('names the interpreter it was given, so the hook runs on this machine', () => {
    install('py -3');
    const cmd = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toBe('py -3 "$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-approval-gate.py"');
  });

  it('keeps the per-clone settings file out of commits', () => {
    install();
    // Exits 0 only when the path is ignored.
    execFileSync('git', ['check-ignore', '-q', '.claude/settings.local.json'], { cwd: root });
  });

  it('keeps what is already in settings.local.json', () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    install();
    const settings = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    expect(settings.permissions.allow).toEqual(['Bash(ls)']);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  it('does nothing the second time', () => {
    install();
    expect(install()).toEqual({});
    expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')).hooks.PreToolUse).toHaveLength(1);
  });

  it('registers nothing when the user settings already run the gate', () => {
    fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-approval-gate.py"' }] }] },
    }));
    const r = install();
    expect(r.script).toBeDefined();
    expect(r.registered).toBeUndefined();
    expect(fs.existsSync(settingsFile())).toBe(false);
  });

  it('never overwrites a script the project has changed', () => {
    const script = path.join(root, '.claude', 'hooks', 'aidlc-approval-gate.py');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '# ours\n');
    expect(install().script).toBeUndefined();
    expect(fs.readFileSync(script, 'utf8')).toBe('# ours\n');
  });
});

describe('bundled approval-gate script', () => {
  it('is the same file this repo runs as its own gate', () => {
    // Two copies: templates/ is what ships, .claude/hooks/ is what this repo
    // dogfoods. A fix to one must reach the other.
    const shipped = fs.readFileSync(path.join(CORE_ROOT, 'templates', 'hooks', 'aidlc-approval-gate.py'), 'utf8');
    const own = fs.readFileSync(path.join(CORE_ROOT, '..', '..', '.claude', 'hooks', 'aidlc-approval-gate.py'), 'utf8');
    expect(shipped.replace(/\r\n/g, '\n')).toBe(own.replace(/\r\n/g, '\n'));
  });
});
