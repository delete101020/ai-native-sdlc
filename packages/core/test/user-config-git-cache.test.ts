import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { readGitUserNameCached } from '../src/loader/userConfig';

describe('readGitUserNameCached', () => {
  it('keeps its answer for a few minutes, then asks git again', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root });
      const setName = (name: string) => execFileSync('git', ['config', 'user.name', name], { cwd: root });
      setName('Ann');
      const t = 1_000_000;
      expect(readGitUserNameCached(root, t)).toBe('Ann');
      setName('Bob');
      expect(readGitUserNameCached(root, t + 60_000)).toBe('Ann');
      expect(readGitUserNameCached(root, t + 6 * 60_000)).toBe('Bob');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
