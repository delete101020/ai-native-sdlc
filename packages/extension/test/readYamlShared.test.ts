import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readYamlShared } from '../src/v2/yamlIO';

// ESM namespaces can't be spied on; wrap statSync so one test can make it throw.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

describe('readYamlShared', () => {
  let root: string;
  const yamlFile = () => path.join(root, '.aidlc', 'workspace.yaml');
  const bump = (file: string) => {
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aidlc-yaml-'));
    fs.mkdirSync(path.join(root, '.aidlc'));
    fs.writeFileSync(yamlFile(), 'version: "1.0"\nname: one\n');
  });

  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('returns the same object while nothing changed', () => {
    expect(readYamlShared(root)).toBe(readYamlShared(root));
  });

  it('re-reads when workspace.yaml changes', () => {
    readYamlShared(root);
    fs.writeFileSync(yamlFile(), 'version: "1.0"\nname: two\n');
    bump(yamlFile());
    expect(readYamlShared(root)?.name).toBe('two');
  });

  it('sees an epic pipeline appear, change and go', () => {
    expect(readYamlShared(root)?.pipelines).toEqual([]);
    const dir = path.join(root, 'docs', 'epics', 'E-1');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'pipeline.yaml');
    fs.writeFileSync(file, 'id: p1\nsteps: []\n');
    expect(readYamlShared(root)?.pipelines.map((p) => p.id)).toEqual(['p1']);
    fs.writeFileSync(file, 'id: p2\nsteps: []\n');
    bump(file);
    expect(readYamlShared(root)?.pipelines.map((p) => p.id)).toEqual(['p2']);
    fs.rmSync(file);
    expect(readYamlShared(root)?.pipelines).toEqual([]);
  });

  it('treats an epic pipeline it cannot stat (EPERM) as absent instead of throwing', () => {
    const dir = path.join(root, 'docs', 'epics', 'LOCKED');
    fs.mkdirSync(dir, { recursive: true });
    const locked = path.join(dir, 'pipeline.yaml');
    const stat = vi.mocked(fs.statSync);
    const real = stat.getMockImplementation()!;
    stat.mockImplementation(((p: fs.PathLike, o?: fs.StatSyncOptions) => {
      if (String(p) === locked) { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); }
      return real(p, o);
    }) as typeof fs.statSync);
    try {
      expect(readYamlShared(root)?.pipelines).toEqual([]);
    } finally {
      stat.mockImplementation(real);
    }
  });

  it('answers null once the file is gone', () => {
    readYamlShared(root);
    fs.rmSync(yamlFile());
    expect(readYamlShared(root)).toBeNull();
  });
});
