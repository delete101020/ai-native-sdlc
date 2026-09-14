/**
 * Follow-up hooks — the workspace's own command, run when an epic hands work
 * forward (`on_followups_opened`) and when a piece of that work is finished
 * (`on_followup_done`).
 *
 * Both are declared on the step that writes `followups.json`, because that step
 * is the one that knows what the handed-forward work means to this workspace —
 * a shared handoff document to keep in sync, a tracker to update. The recipes
 * the children run on are generic and must stay that way.
 *
 * Checked here against the raw document rather than in the Zod step schema:
 * Zod strips keys it does not know, so a misspelt `on_followup_opened` would
 * vanish without a word and the hook would simply never run.
 */

import * as path from 'path';

/** Where a step parks the manifest inside the parent epic. */
export const FOLLOW_UPS_FILE = 'followups.json';

export const FOLLOW_UP_HOOK_KEYS = ['on_followups_opened', 'on_followup_done'] as const;
export type FollowUpHookKey = typeof FOLLOW_UP_HOOK_KEYS[number];

/**
 * Placeholders each hook command may use. `{epic}` is always the parent;
 * `{child}` / `{key}` only mean something when there is one child.
 */
export const FOLLOW_UP_HOOK_PLACEHOLDERS: Record<FollowUpHookKey, readonly string[]> = {
  on_followups_opened: ['epic'],
  on_followup_done: ['epic', 'child', 'key'],
};

export interface FollowUpHookIssue {
  /** Dotted path, e.g. `pipelines.snp.steps.snp-handoff.on_followups_opened`. */
  path: string;
  message: string;
}

function isHookKey(key: string): key is FollowUpHookKey {
  return (FOLLOW_UP_HOOK_KEYS as readonly string[]).includes(key);
}

/** True when a raw step object lists `followups.json` in its `produces`. */
export function stepProducesFollowUps(step: unknown): boolean {
  if (!step || typeof step !== 'object') { return false; }
  const produces = (step as { produces?: unknown }).produces;
  if (!Array.isArray(produces)) { return false; }
  return produces.some(
    (p) => typeof p === 'string' && path.posix.basename(p.replace(/\\/g, '/')) === FOLLOW_UPS_FILE,
  );
}

/**
 * Every problem with follow-up hooks in a raw workspace document: an unknown
 * `on_*` key, an empty command, a hook on a step that does not produce the
 * manifest, or a placeholder the hook is never given.
 */
export function collectFollowUpHookIssues(raw: unknown): FollowUpHookIssue[] {
  const issues: FollowUpHookIssue[] = [];
  const pipelines = (raw as { pipelines?: unknown } | null)?.pipelines;
  if (!Array.isArray(pipelines)) { return issues; }

  pipelines.forEach((pipeline, pi) => {
    const p = (pipeline ?? {}) as { id?: unknown; steps?: unknown };
    if (!Array.isArray(p.steps)) { return; }
    const pid = typeof p.id === 'string' ? p.id : String(pi);

    p.steps.forEach((s, si) => {
      if (!s || typeof s !== 'object') { return; }
      const step = s as Record<string, unknown>;
      const label = typeof step.name === 'string' ? step.name
        : typeof step.agent === 'string' ? step.agent
        : String(si);
      const at = `pipelines.${pid}.steps.${label}`;

      for (const key of Object.keys(step)) {
        if (!key.startsWith('on_')) { continue; }
        if (!isHookKey(key)) {
          issues.push({
            path: `${at}.${key}`,
            message: `unknown hook \`${key}\` — a step can declare ${FOLLOW_UP_HOOK_KEYS.map((k) => `\`${k}\``).join(' or ')}`,
          });
          continue;
        }
        const value = step[key];
        if (typeof value !== 'string' || value.trim().length === 0) {
          issues.push({ path: `${at}.${key}`, message: `\`${key}\` must be a non-empty command` });
          continue;
        }
        if (!stepProducesFollowUps(step)) {
          issues.push({
            path: `${at}.${key}`,
            message: `\`${key}\` belongs on the step that produces ${FOLLOW_UPS_FILE}, and this step's \`produces\` does not list it`,
          });
        }
        const allowed = FOLLOW_UP_HOOK_PLACEHOLDERS[key];
        for (const m of value.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)) {
          if (!allowed.includes(m[1])) {
            issues.push({
              path: `${at}.${key}`,
              message: `\`{${m[1]}}\` is not available in \`${key}\` — it is given ${allowed.map((a) => `\`{${a}}\``).join(', ')}`,
            });
          }
        }
      }
    });
  });
  return issues;
}
