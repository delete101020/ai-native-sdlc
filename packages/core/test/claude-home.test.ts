/**
 * Claude config-dir resolution — the axis a user separates accounts on.
 *
 * Two things are easy to get silently wrong here and both fail without an
 * error message: `.claude.json` moves *inside* a custom config dir but sits
 * *beside* the default one (probe the wrong file and `hasClaudeLogin` reports
 * "no login", which stops the inherited ANTHROPIC_API_KEY from being stripped);
 * and a declared `~/.claude/skills/x.md` has to follow the active account, or
 * `globals install` writes where the running session never looks.
 */
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import {
  setClaudeConfigDir,
  getClaudeConfigDirOverride,
  defaultClaudeConfigDir,
  resolveClaudeConfigDir,
  isDefaultClaudeConfigDir,
  claudeJsonPath,
  claudeConfigEnv,
  remapClaudePath,
} from '../src/util/claudeHome';
import { expandHome } from '../src/util/paths';

const HOME = '/home/dev';
const WORK = '/home/dev/.claude-work';

afterEach(() => { setClaudeConfigDir(undefined); });

describe('resolveClaudeConfigDir', () => {
  it('defaults to <home>/.claude', () => {
    expect(resolveClaudeConfigDir({ homeDir: HOME, env: {} }))
      .toBe(path.join(HOME, '.claude'));
  });

  it('reads CLAUDE_CONFIG_DIR — the variable the CLI itself honours', () => {
    expect(resolveClaudeConfigDir({ homeDir: HOME, env: { CLAUDE_CONFIG_DIR: WORK } }))
      .toBe(WORK);
  });

  it('expands a `~/` config dir', () => {
    expect(resolveClaudeConfigDir({ homeDir: HOME, env: { CLAUDE_CONFIG_DIR: '~/.claude-work' } }))
      .toBe(WORK);
  });

  it('lets the setting override the environment', () => {
    expect(resolveClaudeConfigDir({
      configDir: '/opt/personal',
      homeDir: HOME,
      env: { CLAUDE_CONFIG_DIR: WORK },
    })).toBe('/opt/personal');
  });

  it('lets the process-wide override beat the environment', () => {
    setClaudeConfigDir(WORK);
    expect(getClaudeConfigDirOverride()).toBe(WORK);
    expect(resolveClaudeConfigDir({ homeDir: HOME, env: { CLAUDE_CONFIG_DIR: '/other' } }))
      .toBe(WORK);
  });

  it('treats an empty setting as "not configured"', () => {
    setClaudeConfigDir('   ');
    expect(getClaudeConfigDirOverride()).toBeUndefined();
    expect(resolveClaudeConfigDir({ homeDir: HOME, env: {} }))
      .toBe(defaultClaudeConfigDir(HOME));
  });
});

describe('claudeJsonPath', () => {
  it('sits BESIDE the default dir — ~/.claude.json, not ~/.claude/.claude.json', () => {
    expect(claudeJsonPath({ homeDir: HOME, env: {} }))
      .toBe(path.join(HOME, '.claude.json'));
  });

  it('moves INSIDE a custom config dir', () => {
    expect(claudeJsonPath({ homeDir: HOME, env: { CLAUDE_CONFIG_DIR: WORK } }))
      .toBe(path.join(WORK, '.claude.json'));
  });
});

describe('claudeConfigEnv', () => {
  it('injects nothing on a single-account machine', () => {
    expect(claudeConfigEnv({ homeDir: HOME, env: {} })).toEqual({});
    expect(isDefaultClaudeConfigDir({ homeDir: HOME, env: {} })).toBe(true);
  });

  it('pins CLAUDE_CONFIG_DIR once an account is chosen', () => {
    const opts = { homeDir: HOME, env: { CLAUDE_CONFIG_DIR: WORK } };
    expect(claudeConfigEnv(opts)).toEqual({ CLAUDE_CONFIG_DIR: WORK });
    expect(isDefaultClaudeConfigDir(opts)).toBe(false);
  });
});

describe('declared `~/.claude` paths follow the account', () => {
  it('remaps `~/.claude/<rest>` onto the active dir', () => {
    expect(remapClaudePath('~/.claude/skills/a.md', { homeDir: HOME, env: { CLAUDE_CONFIG_DIR: WORK } }))
      .toBe(path.join(WORK, 'skills', 'a.md'));
  });

  it('remaps the bare `~/.claude` too', () => {
    expect(remapClaudePath('~/.claude', { homeDir: HOME, env: { CLAUDE_CONFIG_DIR: WORK } })).toBe(WORK);
  });

  it('leaves every other path to the plain home expansion', () => {
    expect(remapClaudePath('~/.aidlc/observe-data', { homeDir: HOME })).toBeNull();
    expect(remapClaudePath('~/.claude-backup/x', { homeDir: HOME })).toBeNull();
    expect(remapClaudePath('/etc/skills/a.md', { homeDir: HOME })).toBeNull();
  });

  it('is what expandHome uses, so workspace.yaml stays portable', () => {
    setClaudeConfigDir(WORK);
    expect(expandHome('~/.claude/skills/a.md', HOME)).toBe(path.join(WORK, 'skills', 'a.md'));
    // Unrelated home paths — AIDLC's own storage — must NOT move.
    expect(expandHome('~/.aidlc/observe-data', HOME)).toBe(path.join(HOME, '.aidlc', 'observe-data'));
  });

  it('is a no-op when no account is pinned', () => {
    expect(expandHome('~/.claude/skills/a.md', HOME))
      .toBe(path.join(HOME, '.claude', 'skills', 'a.md'));
  });

  it('resolves against the real home when nothing is passed', () => {
    expect(expandHome('~/.claude')).toBe(path.join(os.homedir(), '.claude'));
  });
});
