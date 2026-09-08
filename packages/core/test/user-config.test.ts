import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  USER_CONFIG_IGNORE_LINE,
  ensureUserConfigIgnored,
  readUserConfig,
  userConfigPath,
  writeUserEpicIdPrefix,
} from '../src/loader/userConfig';

/**
 * `.aidlc/user.yaml` holds the settings that must not be committed.
 *
 * The failure this file guards against is not a crash — it is a file reaching
 * a commit, or a malformed one taking a command down with it. So the tests are
 * about the two edges: the value lands where `.gitignore` can see it, and
 * every unreadable state degrades to "nothing set" rather than throwing.
 */
describe('userConfig', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-user-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('round-trips a prefix, upper-cased', () => {
    writeUserEpicIdPrefix(root, 'kd');
    expect(readUserConfig(root)).toEqual({ epic_id_prefix: 'KD' });
  });

  it('reads nothing at all as null rather than failing', () => {
    expect(readUserConfig(root)).toBeNull();
  });

  it('treats a malformed file as nothing set', () => {
    // Hand-editable and unversioned: a stray tab must not stop an epic from
    // being started.
    fs.mkdirSync(path.dirname(userConfigPath(root)), { recursive: true });
    fs.writeFileSync(userConfigPath(root), 'epic_id_prefix: [unclosed\n\t bad', 'utf8');
    expect(readUserConfig(root)).toBeNull();
  });

  it('leaves other keys alone when the prefix changes', () => {
    fs.mkdirSync(path.dirname(userConfigPath(root)), { recursive: true });
    fs.writeFileSync(userConfigPath(root), 'keep_me: yes\nepic_id_prefix: AA\n', 'utf8');
    writeUserEpicIdPrefix(root, 'BB');
    expect(readUserConfig(root)).toEqual({ keep_me: 'yes', epic_id_prefix: 'BB' });
  });

  it('removes the file rather than leaving an empty one behind', () => {
    writeUserEpicIdPrefix(root, 'KD');
    writeUserEpicIdPrefix(root, null);
    expect(fs.existsSync(userConfigPath(root))).toBe(false);
  });

  it('keeps the file when clearing the prefix would not empty it', () => {
    fs.mkdirSync(path.dirname(userConfigPath(root)), { recursive: true });
    fs.writeFileSync(userConfigPath(root), 'keep_me: yes\nepic_id_prefix: AA\n', 'utf8');
    writeUserEpicIdPrefix(root, null);
    expect(readUserConfig(root)).toEqual({ keep_me: 'yes' });
  });

  it('adds the ignore line once, and reports whether it changed anything', () => {
    expect(ensureUserConfigIgnored(root)).toBe(true);
    const first = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(first).toContain(USER_CONFIG_IGNORE_LINE);

    // Idempotent: a second call must not stack duplicate lines.
    expect(ensureUserConfigIgnored(root)).toBe(false);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(first);
  });

  it('appends to an existing .gitignore without eating its last line', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules', 'utf8');
    ensureUserConfigIgnored(root);
    const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');
    expect(lines).toContain('node_modules');
    expect(lines).toContain(USER_CONFIG_IGNORE_LINE);
  });
});
