import { useState, useMemo, useEffect } from 'react';
import { onHostMessage, getPersistedUi, setPersistedUi } from '@/lib/bridge';
import { Plus, FileCode2, Pencil, Copy, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { WorkspaceState, AgentSummary, SkillSummary, AssetScope } from '@/lib/types';
import { AgentCard, KebabMenu } from './AgentCard';
import { PipelineCard } from './PipelineCard';
import { isEpicOwnedPipeline, selectablePipelines } from '@/lib/pipelines';
import { RenameModal } from './RenameModal';
import { ConfirmModal } from './ConfirmModal';
import { PipelineModal } from './PipelineModal';
import { AddSkillModal } from './AddSkillModal';
import { AddAgentModal } from './AddAgentModal';
import { postMessage } from '@/lib/bridge';

type BuilderTab = 'workflows' | 'agents' | 'skills';

export function BuilderView({
  state,
  focusPipeline,
}: {
  state: WorkspaceState;
  /** "Edit workflow" on an epic card — open Workflows on this pipeline. */
  focusPipeline?: { id: string; nonce: number } | null;
}) {
  const [tab, setTab] = useState<BuilderTab>('agents');
  const [addPipelineOpen, setAddPipelineOpen] = useState(false);
  const [addSkillOpen, setAddSkillOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  // Off by default — one dead row per epic started is what the filter is for.
  // The toggle is the way back to an epic's own workflow when it does need a
  // change, and it lives here rather than in the grid so the tab badge and the
  // list can never disagree about what "Workflows" means.
  const [showEpicOwned, setShowEpicOwned] = useState(
    () => getPersistedUi<PersistedBuilderUi>()?.showEpicPipelines === true,
  );

  const onToggleEpicOwned = (next: boolean) => {
    setShowEpicOwned(next);
    const prev = getPersistedUi<PersistedBuilderUi>() ?? {};
    setPersistedUi<PersistedBuilderUi>({ ...prev, showEpicPipelines: next });
  };

  const visiblePipelines = useMemo(
    () => (showEpicOwned ? state.pipelines : selectablePipelines(state.pipelines)),
    [state.pipelines, showEpicOwned],
  );

  const tabs: { id: BuilderTab; label: string; count: number }[] = [
    { id: 'workflows', label: 'Workflows', count: visiblePipelines.length },
    { id: 'agents', label: 'Agents', count: state.agents.length },
    { id: 'skills', label: 'Skills', count: state.skills.length },
  ];

  const addLabel = tab === 'workflows'
    ? 'Add Pipeline'
    : tab === 'agents'
    ? 'Add Agent'
    : 'Add Skill';

  // Agent picker shown in AddPipelineModal — project + global only.
  // Mirrors the Agents tab so the user picks from the same set they see
  // in the Builder, not the workspace.yaml-only AIDLC layer (which is
  // hidden from the UI for this exact reason).
  const pipelineAgents = useMemo(
    () => state.agents.filter((a) => a.scope === 'project' || a.scope === 'global'),
    [state.agents],
  );

  const onAdd = () => {
    if (tab === 'workflows') { setAddPipelineOpen(true); }
    else if (tab === 'agents') { setAddAgentOpen(true); }
    else { setAddSkillOpen(true); }
  };

  // Stat tiles in the sidebar deep-link into a tab via `setBuilderTab`.
  // (Epics live in the separate top-level Epics view, handled there.)
  useEffect(() => {
    return onHostMessage((msg) => {
      if (msg.type === 'setBuilderTab') {
        const t = msg.tab;
        if (t === 'workflows' || t === 'agents' || t === 'skills') {
          setTab(t);
        }
      } else if (msg.type === 'triggerAddPipeline') {
        // Start-Epic modal's "Create new pipeline" → open the Workflows tab
        // and pop the inline Add-pipeline modal.
        setTab('workflows');
        setAddPipelineOpen(true);
      }
    });
  }, []);

  // An epic's own pipeline is hidden by default, so landing on the Workflows
  // tab is not enough — unhide it too, or the deep link opens on a list that
  // does not contain what the user clicked.
  useEffect(() => {
    if (!focusPipeline) { return; }
    setTab('workflows');
    const target = state.pipelines.find((p) => p.id === focusPipeline.id);
    if (target && isEpicOwnedPipeline(target)) { onToggleEpicOwned(true); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPipeline]);

  const allSkillIds = useMemo(() => state.skills.map((s) => s.id), [state.skills]);
  const allAgentIds = useMemo(() => state.agents.map((a) => a.id), [state.agents]);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground">AIDLC Builder</h1>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Workspace</span>
            <span>·</span>
            <span>Agents</span>
            <span>·</span>
            <span>Skills</span>
            <span>·</span>
            <span>Pipelines</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </button>
      </div>

      <div className="flex gap-1 border-b border-border">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1.5 border-b-2 px-4 py-2.5 text-xs font-medium transition-colors',
              tab === t.id
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums',
                tab === t.id ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground',
              )}
            >
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {tab === 'agents' && <AgentsByScope agents={state.agents} skills={state.skills} />}
      {tab === 'skills' && <SkillsByScope skills={state.skills} />}
      {tab === 'workflows' && (
        <PipelinesGrid
          state={state}
          pipelines={visiblePipelines}
          showEpicOwned={showEpicOwned}
          onToggleEpicOwned={onToggleEpicOwned}
          focusPipeline={focusPipeline}
        />
      )}

      {addPipelineOpen && (
        <PipelineModal
          mode="add"
          agents={pipelineAgents}
          existingPipelineIds={state.pipelines.map((p) => p.id)}
          aidlcDefault={
            state.defaultPipeline
              ? {
                  on_failure: state.defaultPipeline.on_failure,
                  steps: state.defaultPipeline.steps.map((s) => ({
                    agent: s.agent,
                    name: s.name,
                    skills: s.skills,
                    human_review: s.human_review,
                    auto_review: s.auto_review,
                    auto_review_runner: s.auto_review_runner,
                    depends_on: s.depends_on,
                  })),
                }
              : undefined
          }
          onSubmit={(draft) =>
            postMessage({ type: 'addPipelineInline', draft })
          }
          onClose={() => setAddPipelineOpen(false)}
        />
      )}
      {addSkillOpen && (
        <AddSkillModal
          takenIds={allSkillIds}
          templates={state.skillTemplates}
          onSubmit={(draft) => postMessage({ type: 'addSkillInline', draft })}
          onClose={() => setAddSkillOpen(false)}
        />
      )}
      {addAgentOpen && (
        <AddAgentModal
          takenIds={allAgentIds}
          skills={state.skills}
          skillTemplates={state.skillTemplates}
          takenSkillIds={allSkillIds}
          onSubmit={(draft) => postMessage({ type: 'addAgentInline', draft })}
          onClose={() => setAddAgentOpen(false)}
        />
      )}
    </div>
  );
}

function pickInitialScope<T extends { scope: AssetScope }>(
  items: T[],
  persisted: AssetScope | undefined,
): AssetScope {
  // AIDLC scope is intentionally hidden from the picker dropdown — never
  // return it here, otherwise the dropdown shows the wrong label (its
  // option doesn't exist) and the list filter quietly displays the
  // hidden bucket. Picker has only project + global now.
  if (persisted === 'project' || persisted === 'global') {
    if (items.some((i) => i.scope === persisted)) { return persisted; }
  }
  if (items.some((i) => i.scope === 'project')) { return 'project'; }
  return 'global';
}

function ScopeFilter({
  scope, counts, onChange,
}: {
  scope: AssetScope;
  counts: Record<AssetScope, number>;
  onChange: (next: AssetScope) => void;
}) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <label htmlFor="scope-filter" className="text-xs font-medium text-muted-foreground">
        Source
      </label>
      <select
        id="scope-filter"
        value={scope}
        onChange={(e) => onChange(e.target.value as AssetScope)}
        className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
      >
        <option value="project">Project — .claude/ ({counts.project})</option>
        <option value="global">Global — ~/.claude/ ({counts.global})</option>
        {counts.aidlc > 0 && <option value="aidlc">AIDLC — workspace.yaml ({counts.aidlc})</option>}
      </select>
    </div>
  );
}

function AgentsByScope({ agents, skills }: { agents: AgentSummary[]; skills: SkillSummary[] }) {
  const grouped = useMemo(() => groupByScope(agents), [agents]);
  const counts = { project: grouped.project.length, aidlc: grouped.aidlc.length, global: grouped.global.length };
  const [scope, setScope] = useState<AssetScope>(() =>
    pickInitialScope(agents, getPersistedUi<PersistedBuilderUi>()?.agentScope),
  );
  useEffect(() => {
    if (agents.length === 0) { return; }
    if (grouped[scope].length === 0) {
      setScope(pickInitialScope(agents, getPersistedUi<PersistedBuilderUi>()?.agentScope));
    }
  }, [agents, grouped, scope]);

  const aidlcIds = useMemo(
    () => agents.filter((a) => a.scope === 'aidlc').map((a) => a.id),
    [agents],
  );
  if (agents.length === 0) { return <EmptyHint kind="agents" />; }

  const onChange = (next: AssetScope) => {
    setScope(next);
    const prev = getPersistedUi<PersistedBuilderUi>() ?? {};
    setPersistedUi<PersistedBuilderUi>({ ...prev, agentScope: next });
  };

  const list = grouped[scope];
  return (
    <>
      <ScopeFilter scope={scope} counts={counts} onChange={onChange} />
      {list.length === 0 ? (
        <EmptyHint kind="agents" />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((a) => (
            <AgentCard key={`${a.scope}/${a.id}`} agent={a} allAgentIds={aidlcIds} skills={skills} />
          ))}
        </div>
      )}
    </>
  );
}

function SkillsByScope({ skills }: { skills: SkillSummary[] }) {
  const grouped = useMemo(() => groupByScope(skills), [skills]);
  const counts = { project: grouped.project.length, aidlc: grouped.aidlc.length, global: grouped.global.length };
  const [scope, setScope] = useState<AssetScope>(() =>
    pickInitialScope(skills, getPersistedUi<PersistedBuilderUi>()?.skillScope),
  );
  useEffect(() => {
    if (skills.length === 0) { return; }
    if (grouped[scope].length === 0) {
      setScope(pickInitialScope(skills, getPersistedUi<PersistedBuilderUi>()?.skillScope));
    }
  }, [skills, grouped, scope]);

  const aidlcIds = useMemo(
    () => skills.filter((s) => s.scope === 'aidlc').map((s) => s.id),
    [skills],
  );
  if (skills.length === 0) { return <EmptyHint kind="skills" />; }

  const onChange = (next: AssetScope) => {
    setScope(next);
    const prev = getPersistedUi<PersistedBuilderUi>() ?? {};
    setPersistedUi<PersistedBuilderUi>({ ...prev, skillScope: next });
  };

  const list = grouped[scope];
  return (
    <>
      <ScopeFilter scope={scope} counts={counts} onChange={onChange} />
      {list.length === 0 ? (
        <EmptyHint kind="skills" />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((s) => (
            <SkillCard key={`${s.scope}/${s.id}`} skill={s} allSkillIds={aidlcIds} />
          ))}
        </div>
      )}
    </>
  );
}

function SkillCard({ skill, allSkillIds }: { skill: SkillSummary; allSkillIds: string[] }) {
  const isAidlc = skill.scope === 'aidlc';
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const onClick = () => {
    if (skill.filePath) { postMessage({ type: 'openSkill', filePath: skill.filePath }); }
    else if (isAidlc) { postMessage({ type: 'openYaml' }); }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className="group flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-card p-3.5 transition-all hover:border-primary/40"
    >
      <FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="truncate text-sm font-semibold text-primary">{skill.id}</div>
          {skill.builtinFrom && (
            <span
              title={`Installed by the built-in preset: ${skill.builtinFrom}`}
              className="inline-flex shrink-0 items-center rounded border border-info/30 bg-info/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-info"
            >
              BUILT-IN
            </span>
          )}
        </div>
        {skill.description && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{skill.description}</p>
        )}
        {skill.builtinFrom && (
          <p className="mt-0.5 truncate text-[10px] italic text-muted-foreground">
            from {skill.builtinFrom}
          </p>
        )}
      </div>
      {isAidlc && (
        <KebabMenu
          items={[
            {
              label: 'Rename',
              icon: <Pencil className="h-3 w-3" />,
              onSelect: () => setRenameOpen(true),
            },
            {
              label: 'Duplicate',
              icon: <Copy className="h-3 w-3" />,
              action: 'duplicateSkill',
            },
            {
              label: 'Delete',
              icon: <Trash2 className="h-3 w-3" />,
              onSelect: () => setDeleteOpen(true),
              danger: true,
            },
          ]}
          payload={{ id: skill.id }}
        />
      )}

      {renameOpen && (
        <RenameModal
          kind="skill"
          currentId={skill.id}
          existingIds={allSkillIds}
          onRename={(newId) =>
            postMessage({ type: 'renameSkill', id: skill.id, newId })
          }
          onClose={() => setRenameOpen(false)}
        />
      )}
      {deleteOpen && (
        <ConfirmModal
          title="Delete skill"
          danger
          confirmLabel="Delete"
          message={
            <>
              Delete skill <span className="font-mono">{skill.id}</span> from{' '}
              <span className="font-mono">workspace.yaml</span>? File on disk is kept.
            </>
          }
          onConfirm={() =>
            postMessage({ type: 'deleteSkill', id: skill.id, confirmed: true })
          }
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
}

const DEFAULT_PIPELINE_ID = 'aidlc-workflow-full';

interface PersistedBuilderUi {
  workflowDomain?: string;
  showEpicPipelines?: boolean;
  agentScope?: AssetScope;
  skillScope?: AssetScope;
}

function pickInitialPipelineId(pipelines: WorkspaceState['pipelines']): string {
  if (pipelines.length === 0) { return ''; }
  const persisted = getPersistedUi<PersistedBuilderUi>()?.workflowDomain;
  if (persisted && pipelines.some((p) => p.id === persisted)) { return persisted; }
  if (pipelines.some((p) => p.id === DEFAULT_PIPELINE_ID)) { return DEFAULT_PIPELINE_ID; }
  return pipelines[0].id;
}

function PipelinesGrid({
  state,
  pipelines: workflows,
  showEpicOwned,
  onToggleEpicOwned,
  focusPipeline,
}: {
  state: WorkspaceState;
  /** Already filtered by BuilderView — see `showEpicOwned`. */
  pipelines: WorkspaceState['pipelines'];
  showEpicOwned: boolean;
  onToggleEpicOwned: (next: boolean) => void;
  focusPipeline?: { id: string; nonce: number } | null;
}) {
  const [selectedId, setSelectedId] = useState(() => pickInitialPipelineId(workflows));

  // Re-resolve the selection when the pipeline list changes (e.g. a workflow
  // was just applied / removed). Falls back through persisted → sdlc default →
  // first available so the dropdown never points at a stale id.
  useEffect(() => {
    if (workflows.length === 0) { return; }
    if (!workflows.some((p) => p.id === selectedId)) {
      setSelectedId(pickInitialPipelineId(workflows));
    }
  }, [workflows, selectedId]);

  // A deep link from an epic card names the pipeline to show. It only reaches
  // the list once BuilderView has unhidden epic-owned rows, so guard on
  // membership rather than assuming it is selectable.
  useEffect(() => {
    if (!focusPipeline) { return; }
    if (workflows.some((p) => p.id === focusPipeline.id)) { setSelectedId(focusPipeline.id); }
  }, [focusPipeline, workflows]);

  const { builtinOptions, customOptions, epicOptions } = useMemo(() => {
    const epic = workflows.filter((p) => isEpicOwnedPipeline(p));
    const rest = workflows.filter((p) => !isEpicOwnedPipeline(p));
    return {
      builtinOptions: rest.filter((p) => p.builtin === true),
      customOptions: rest.filter((p) => p.builtin !== true),
      epicOptions: epic,
    };
  }, [workflows]);

  // The toggle rides along with the empty state too: with every pipeline owned
  // by an epic, hiding them leaves an empty list and no visible way back.
  if (workflows.length === 0) {
    return (
      <div className="space-y-3">
        <EpicPipelineToggle checked={showEpicOwned} onChange={onToggleEpicOwned} />
        <EmptyHint kind="pipelines" />
      </div>
    );
  }
  // PipelineCard renders existing steps + lets the user swap the agent on
  // each row. Existing built-in pipelines reference workspace.yaml-only
  // AIDLC agents (`plan`, `design`, …); new ones reference file-based
  // project/global agents. Pass the union so both render correctly.
  const allAgents = state.agents;
  const selected = workflows.find((p) => p.id === selectedId) ?? workflows[0];

  const onChange = (id: string) => {
    setSelectedId(id);
    const prev = getPersistedUi<PersistedBuilderUi>() ?? {};
    setPersistedUi<PersistedBuilderUi>({ ...prev, workflowDomain: id });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label htmlFor="pipeline-domain" className="text-xs font-medium text-muted-foreground">
          Domain
        </label>
        <select
          id="pipeline-domain"
          value={selected.id}
          onChange={(e) => onChange(e.target.value)}
          className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
        >
          {builtinOptions.length > 0 && (
            <optgroup label="Built-in workflows">
              {builtinOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? p.id}
                </option>
              ))}
            </optgroup>
          )}
          {customOptions.length > 0 && (
            <optgroup label="Your workflows">
              {customOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? p.id}
                </option>
              ))}
            </optgroup>
          )}
          {epicOptions.length > 0 && (
            <optgroup label="Epic pipelines">
              {epicOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name ?? p.id}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <span className="text-[11px] text-muted-foreground">
          {workflows.length} available
        </span>
        <EpicPipelineToggle checked={showEpicOwned} onChange={onToggleEpicOwned} />
      </div>
      <PipelineCard
        pipeline={selected}
        agents={allAgents}
        runIds={state.runIds}
        allPipelineIds={state.pipelines.map((p) => p.id)}
      />
    </div>
  );
}

/**
 * Un-hides the pipelines an epic owns (`docs/epics/<id>/pipeline.yaml`).
 *
 * They are off by default because one arrives per epic started and none of
 * them is a workflow to author against — but an epic's own run shape is still
 * editable (gates always; the step list until a run pins it), and this is the
 * only place to reach it besides the epic card's "Edit workflow".
 */
function EpicPipelineToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      className="ml-auto inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      title="Show the pipeline each epic owns (docs/epics/<id>/pipeline.yaml). Hidden by default — one row per epic started, none of them reusable as a workflow."
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 accent-primary"
      />
      Show epic pipelines
    </label>
  );
}

function groupByScope<T extends { scope: AssetScope }>(items: T[]): Record<AssetScope, T[]> {
  const out: Record<AssetScope, T[]> = { project: [], aidlc: [], global: [] };
  for (const it of items) { out[it.scope].push(it); }
  return out;
}

function EmptyHint({ kind }: { kind: 'agents' | 'skills' | 'pipelines' | 'epics' }) {
  if (kind === 'pipelines') {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface/50 p-8 text-center text-xs text-muted-foreground">
        <div className="mb-2 text-sm font-medium text-foreground">No pipelines yet.</div>
        <div className="leading-relaxed">
          Load a common workflow from the{' '}
          <span className="font-medium text-foreground">Workflows</span> section in the
          left sidebar, or click{' '}
          <span className="font-medium text-foreground">Add Pipeline</span> at the
          top-right to build your own.
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-dashed border-border bg-surface/50 p-6 text-center text-xs text-muted-foreground">
      No {kind} yet.
    </div>
  );
}
