import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveCommand, clearResolveCommandCache } from '../src';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-bin-'));
}

function touch(p: string, body = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

// The npm cmd-shim templates, verbatim in the parts that matter.
const NATIVE_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
].join('\r\n');
const NODE_SHIM = [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n');

describe('resolveCommand', () => {
  beforeEach(() => clearResolveCommandCache());

  it('is the identity off Windows', () => {
    expect(resolveCommand('claude', { platform: 'linux', env: { PATH: '/nope' } })).toEqual({ command: 'claude', args: [] });
  });

  it.runIf(process.platform === 'win32')('unwraps an npm shim that execs a native binary', () => {
    const dir = tmp();
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    touch(exe);
    touch(path.join(dir, 'claude.cmd'), NATIVE_SHIM);
    expect(resolveCommand('claude', { platform: 'win32', env: { PATH: dir } })).toEqual({ command: exe, args: [] });
  });

  it.runIf(process.platform === 'win32')('unwraps an npm shim that runs a script under node', () => {
    const dir = tmp();
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    touch(script);
    touch(path.join(dir, 'node.exe'));
    touch(path.join(dir, 'codex.cmd'), NODE_SHIM);
    expect(resolveCommand('codex', { platform: 'win32', env: { PATH: dir } }))
      .toEqual({ command: path.join(dir, 'node.exe'), args: [script] });
  });

  it.runIf(process.platform === 'win32')('prefers a real .exe earlier on PATH over a later shim', () => {
    const a = tmp();
    const b = tmp();
    touch(path.join(a, 'claude.exe'));
    touch(path.join(b, 'claude.cmd'), NATIVE_SHIM);
    expect(resolveCommand('claude', { platform: 'win32', env: { PATH: `${a};${b}` } }).command).toBe(path.join(a, 'claude.exe'));
  });

  it.runIf(process.platform === 'win32')('falls back to cmd.exe for a shim it cannot read', () => {
    const dir = tmp();
    touch(path.join(dir, 'tool.cmd'), '@echo hi');
    expect(resolveCommand('tool', { platform: 'win32', env: { PATH: dir, ComSpec: 'C:\\Windows\\system32\\cmd.exe' } }))
      .toEqual({ command: 'C:\\Windows\\system32\\cmd.exe', args: ['/d', '/c', path.join(dir, 'tool.cmd')] });
  });

  it('leaves an unknown name alone, so the spawn error still names it', () => {
    expect(resolveCommand('nope-cli', { platform: 'win32', env: { PATH: tmp() } })).toEqual({ command: 'nope-cli', args: [] });
  });
});
