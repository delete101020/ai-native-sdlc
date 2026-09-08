/**
 * Is a command body on disk older than the features it is supposed to mention?
 *
 * `writeWorkflowCommands` and `writeTwoLayerCommands` never overwrite an
 * existing file, so a hand-tuned command survives an upgrade. The cost of that
 * courtesy is that a body written by an older build silently ignores every
 * setting added since — the user flips the setting, nothing happens, and
 * nothing says why. Each such setting leaves a heading in the body it
 * generates, and a body missing one cannot have come from this build.
 *
 * One function so the next setting adds one line here instead of a third
 * condition at every provisioning site.
 */

import { commandBodyPredatesArtifactLanguage } from '../loader/artifactLanguage';
import { commandBodyPredatesStrictMode } from '../loader/strictMode';

export function commandBodyIsStale(existing: string): boolean {
  return commandBodyPredatesArtifactLanguage(existing)
    || commandBodyPredatesStrictMode(existing);
}
