import { describe, expect, it } from 'vitest';

import { producesWatchGlobs } from '../src/v2/epicsList';

/**
 * The panel reads each step's artifacts off disk, so it has to be told when
 * disk changes. Its other watchers cover run bookkeeping and the built-in
 * `artifacts/` layout only — a workflow writing to `docs/cr/<id>/` matched
 * none of them, and its outputs read "not produced yet" until something
 * unrelated forced a refresh.
 */
const asDoc = (pipelines: unknown) =>
  ({ pipelines }) as unknown as Parameters<typeof producesWatchGlobs>[0];

describe('producesWatchGlobs', () => {
  it('watches the directory above a placeholder', () => {
    const globs = producesWatchGlobs(asDoc([{
      id: 'cr',
      steps: [
        { agent: 'ba', produces: ['docs/cr/{epic}/kickoff.md'] },
        { agent: 'dev', produces: ['docs/cr/{epic}/diagrams/'] },
      ],
    }]));

    expect(globs).toEqual(['docs/cr/**']);
  });

  it('keeps a path with no placeholder as itself', () => {
    const globs = producesWatchGlobs(asDoc([{
      id: 'x',
      steps: [{ agent: 'a', produces: ['docs/report.md', 'build/out/'] }],
    }]));

    expect(globs).toEqual(['build/out/**', 'docs/report.md']);
  });

  it('covers several pipelines at once, deduped', () => {
    const globs = producesWatchGlobs(asDoc([
      { id: 'a', steps: [{ agent: 'x', produces: ['docs/epics/{epic}/artifacts/spec.md'] }] },
      { id: 'b', steps: [{ agent: 'y', produces: ['docs/epics/{epic}/artifacts/prd.md'] }] },
      { id: 'c', steps: [{ agent: 'z', produces: ['docs/snp/{topic}.md'] }] },
    ]));

    expect(globs).toEqual(['docs/epics/**', 'docs/snp/**']);
  });

  it('drops what a folder-relative glob cannot express', () => {
    const globs = producesWatchGlobs(asDoc([{
      id: 'x',
      steps: [{
        agent: 'a',
        produces: [
          'C:/elsewhere/{epic}/out.md',   // absolute — outside the folder
          '/var/tmp/{epic}/out.md',       // absolute — outside the folder
          '{epic}/out.md',                // would watch the whole repo
        ],
      }],
    }]));

    expect(globs).toEqual([]);
  });

  it('answers nothing for a workspace with no pipelines', () => {
    expect(producesWatchGlobs(null)).toEqual([]);
    expect(producesWatchGlobs(asDoc(undefined))).toEqual([]);
    expect(producesWatchGlobs(asDoc([{ id: 'broken' }]))).toEqual([]);
  });

  it('caps the number of watchers', () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({
      agent: 'a',
      produces: [`out${i}/{epic}/x.md`],
    }));

    expect(producesWatchGlobs(asDoc([{ id: 'many', steps }]))).toHaveLength(12);
  });
});
