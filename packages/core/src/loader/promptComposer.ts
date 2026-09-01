/**
 * Builds the system prompt for one pipeline step: persona, project
 * instructions, skills — in that order, and only the parts the runner's harness
 * does not already supply.
 *
 * Before this existed, `execEngine` sent the skills and nothing else, and the
 * skills reached the rest by *naming file paths* (`.claude/agents/…`,
 * `CLAUDE.md`). That works only on a harness with Claude's directory layout,
 * and it is what made "run this phase on another CLI" a quality question rather
 * than a wiring question. See MULTI_PROVIDER_ALIGNMENT.md §4c.
 *
 * Section headings match `composeSkill` in `presets/builtinWorkflows.ts`, which
 * does the same composition for the *interactive* slash-command path, so a
 * phase reads the same whether it was entered from a terminal or from `aidlc run`.
 */

import type { LoadedPersona } from './PersonaLoader';
import type { ProjectInstructions } from './projectInstructions';
import type { HarnessCapabilities } from '../runner/types';

/**
 * The persona used to arrive as an instruction to go and read a file. Once the
 * persona is inlined, that line is worse than redundant: it sends the model to
 * a path that may not exist under another harness. Same regex `composeSkill`
 * uses, kept in step with it.
 */
export function stripPersonaDirectives(skillText: string): string {
  return skillText
    .replace(/^.*Load your full persona from `?\.?\.?\/?\.claude\/agents\/[^\n]*\n/gm, '')
    .replace(/^.*Reference `?\.?\.?\/?\.claude\/agents\/[^\n]*\n/gm, '');
}

export interface ComposeInput {
  /** Concatenated skill markdown — the "what to do" layer. Always included. */
  skills: string;
  /** Resolved persona, or null when the agent has none. */
  persona: LoadedPersona | null;
  /** Resolved project instructions, or null when the repo has none. */
  instructions: ProjectInstructions | null;
  /** What the target harness supplies without our help. */
  harness: HarnessCapabilities;
}

export interface ComposedPrompt {
  /** The prompt text to hand the runner as `ctx.skill`. */
  text: string;
  /** Which layers this composition actually inlined — for `--dry-run` and doctor. */
  included: { persona: boolean; instructions: boolean };
}

export function composeAgentPrompt(input: ComposeInput): ComposedPrompt {
  const { skills, persona, instructions, harness } = input;

  const inlinePersona = !!persona && !harness.persona;
  const inlineInstructions = !!instructions && !harness.projectInstructions;

  // Nothing to add ⇒ hand the skills through untouched. A workspace whose
  // agents have no persona file must see the exact prompt it saw before.
  if (!inlinePersona && !inlineInstructions) {
    return { text: skills, included: { persona: false, instructions: false } };
  }

  const parts: string[] = [];

  if (inlinePersona && persona) {
    parts.push(['## Persona', '', persona.content].join('\n'));
  }

  if (inlineInstructions && instructions) {
    parts.push([
      `## Project instructions (\`${instructions.relPath}\`)`,
      '',
      'These are the repository\'s own standing rules. They bind this phase.',
      '',
      instructions.content,
    ].join('\n'));
  }

  // The skill layer keeps its path-based persona directive only when nothing
  // has replaced it — i.e. when the harness loads the persona itself.
  const skillText = inlinePersona ? stripPersonaDirectives(skills) : skills;
  parts.push(['## Phase Behavior', '', skillText.trim()].join('\n'));

  return {
    text: parts.join('\n\n---\n\n') + '\n',
    included: { persona: inlinePersona, instructions: inlineInstructions },
  };
}
