/**
 * Pure half of the `aidlc.*` → `aidlcNative.*` settings migration (no vscode
 * import, so it is unit-testable). The applier lives in `settingsMigration.ts`.
 */

export const LEGACY_PREFIX = 'aidlc.';
export const CURRENT_PREFIX = 'aidlcNative.';

/** The settings levels a value can live at, broadest first. */
export type SettingLevel = 'global' | 'workspace' | 'workspaceFolder';

/** The subset of `WorkspaceConfiguration.inspect()` the plan reads. */
export interface InspectedValues {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

export interface SettingMove {
  /** Key without prefix, e.g. `claude.configDir`. */
  key: string;
  level: SettingLevel;
  value: unknown;
}

const VALUE_AT: Record<SettingLevel, keyof InspectedValues> = {
  global: 'globalValue',
  workspace: 'workspaceValue',
  workspaceFolder: 'workspaceFolderValue',
};

/**
 * Every value the user set under the legacy key at `level` whose current key
 * is still unset there. A value already set under the new key always wins, so
 * running the plan twice copies nothing the second time.
 */
export function planSettingsMigration(
  keys: readonly string[],
  levels: readonly SettingLevel[],
  inspect: (fullKey: string) => InspectedValues | undefined,
): SettingMove[] {
  const moves: SettingMove[] = [];
  for (const key of keys) {
    const legacy = inspect(LEGACY_PREFIX + key);
    if (!legacy) continue;
    const current = inspect(CURRENT_PREFIX + key);
    for (const level of levels) {
      const field = VALUE_AT[level];
      if (legacy[field] === undefined || current?.[field] !== undefined) continue;
      moves.push({ key, level, value: legacy[field] });
    }
  }
  return moves;
}

/** Contributed setting keys, without the prefix, from the extension manifest. */
export function contributedSettingKeys(packageJson: unknown): string[] {
  const props = (packageJson as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } };
  })?.contributes?.configuration?.properties ?? {};
  return Object.keys(props)
    .filter((k) => k.startsWith(CURRENT_PREFIX))
    .map((k) => k.slice(CURRENT_PREFIX.length));
}
