'use client';

import { useEffect, useRef, useState } from 'react';

import { createId } from '@/lib/utils/ids';
import { normalizeExplainer } from '@/lib/projects/explainer-normalization';
import type { Project } from '@/lib/types/render';
import type { SceneIntentDraft, SceneIntentNarrativeRole, StoryBeat } from '@/lib/types/explainer';

interface ExplainerStoryWorkspaceProps {
  project: Project;
  onProjectChange: (nextProject: Project) => void;
  onNavigateToTab: (tab: 'scenes' | 'assets' | 'references') => void;
  focusArea?: 'brief' | 'story' | 'scene_plan' | null;
  focusRequestId?: number;
  onOpenScene: (sceneId: string) => void;
}

const SCENE_INTENT_ROLES: SceneIntentNarrativeRole[] = ['hook', 'setup', 'explanation', 'example', 'transition', 'summary', 'cta', 'custom'];

function withExplainer(project: Project) {
  return project.explainer ?? normalizeExplainer(project);
}

function reindexBeats(beats: StoryBeat[]): StoryBeat[] {
  return beats
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((beat, index) => ({ ...beat, order: index + 1 }));
}

function reindexSceneIntents(sceneIntents: SceneIntentDraft[]): SceneIntentDraft[] {
  return sceneIntents
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((intent, index) => ({ ...intent, order: index + 1 }));
}

export function ExplainerStoryWorkspace({ project, onProjectChange, onNavigateToTab, focusArea = null, focusRequestId = 0, onOpenScene }: ExplainerStoryWorkspaceProps) {
  const explainer = withExplainer(project);
  const beats = reindexBeats(explainer.story.beats);
  const sceneIntents = reindexSceneIntents(explainer.sceneIntents);
  const [scenePlanMessage, setScenePlanMessage] = useState('');
  const [planningBusy, setPlanningBusy] = useState(false);
  const [materializingIntentId, setMaterializingIntentId] = useState<string | null>(null);
  const [materializingAll, setMaterializingAll] = useState(false);
  const briefSectionRef = useRef<HTMLElement | null>(null);
  const storySectionRef = useRef<HTMLElement | null>(null);
  const scenePlanSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!focusArea) {
      return;
    }

    const target =
      focusArea === 'brief'
        ? briefSectionRef.current
        : focusArea === 'story'
          ? storySectionRef.current
          : scenePlanSectionRef.current;

    if (!target) {
      return;
    }

    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focusArea, focusRequestId]);

  function update(nextExplainer: Project['explainer']) {
    onProjectChange({
      ...project,
      explainer: nextExplainer
    });
  }

  function addBeat() {
    update({
      ...explainer,
      story: {
        ...explainer.story,
        beats: [
          ...beats,
          {
            id: createId('beat'),
            order: beats.length + 1,
            label: `Beat ${beats.length + 1}`,
            text: ''
          }
        ]
      }
    });
  }

  function deleteBeat(beatId: string) {
    update({
      ...explainer,
      story: {
        ...explainer.story,
        beats: reindexBeats(beats.filter((beat) => beat.id !== beatId))
      }
    });
  }

  function moveBeat(beatId: string, direction: 'up' | 'down') {
    const index = beats.findIndex((beat) => beat.id === beatId);
    if (index < 0) return;
    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= beats.length) return;

    const next = beats.slice();
    const current = next[index];
    next[index] = next[nextIndex];
    next[nextIndex] = current;

    update({
      ...explainer,
      story: {
        ...explainer.story,
        beats: reindexBeats(next)
      }
    });
  }

  function updateBeat(beatId: string, patch: Partial<StoryBeat>) {
    update({
      ...explainer,
      story: {
        ...explainer.story,
        beats: reindexBeats(beats.map((beat) => (beat.id === beatId ? { ...beat, ...patch } : beat)))
      }
    });
  }

  function snapshotScriptVersion() {
    const script = explainer.story.script.trim();
    if (!script) {
      return;
    }

    update({
      ...explainer,
      story: {
        ...explainer.story,
        versions: [
          {
            id: createId('script_version'),
            script: explainer.story.script,
            createdAt: new Date().toISOString(),
            source: 'manual'
          },
          ...explainer.story.versions
        ]
      }
    });
  }

  function addSceneIntent() {
    update({
      ...explainer,
      sceneIntents: [
        ...sceneIntents,
        {
          id: createId('scene_intent'),
          order: sceneIntents.length + 1,
          beatIds: beats[0] ? [beats[0].id] : [],
          label: `Intent ${sceneIntents.length + 1}`,
          narrativeRole: sceneIntents.length === 0 ? 'hook' : 'explanation',
          visualIntent: '',
          narrationDraft: '',
          timing: { durationSeconds: 5 },
          notes: '',
          status: 'draft'
        }
      ]
    });
  }

  function updateSceneIntent(intentId: string, patch: Partial<SceneIntentDraft>) {
    update({
      ...explainer,
      sceneIntents: reindexSceneIntents(sceneIntents.map((intent) => (intent.id === intentId ? { ...intent, ...patch } : intent)))
    });
  }

  function deleteSceneIntent(intentId: string) {
    update({
      ...explainer,
      sceneIntents: reindexSceneIntents(sceneIntents.filter((intent) => intent.id !== intentId))
    });
  }

  function moveSceneIntent(intentId: string, direction: 'up' | 'down') {
    const index = sceneIntents.findIndex((intent) => intent.id === intentId);
    if (index < 0) return;
    const nextIndex = direction === 'up' ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= sceneIntents.length) return;

    const next = sceneIntents.slice();
    const current = next[index];
    next[index] = next[nextIndex];
    next[nextIndex] = current;

    update({
      ...explainer,
      sceneIntents: reindexSceneIntents(next)
    });
  }

  function toggleIntentBeat(intentId: string, beatId: string) {
    update({
      ...explainer,
      sceneIntents: reindexSceneIntents(sceneIntents.map((intent) => {
        if (intent.id !== intentId) {
          return intent;
        }

        const exists = intent.beatIds.includes(beatId);
        const beatIds = exists ? intent.beatIds.filter((entry) => entry !== beatId) : [...intent.beatIds, beatId];
        return {
          ...intent,
          beatIds
        };
      }))
    });
  }

  async function createSceneIntentsFromBeats() {
    setPlanningBusy(true);
    setScenePlanMessage('Creating scene intents from beats...');

    const response = await fetch(`/api/projects/${project.id}/scene-intents/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: {
          ...project,
          explainer: {
            ...explainer,
            story: {
              ...explainer.story,
              beats
            },
            sceneIntents
          }
        }
      })
    });

    const body = (await response.json().catch(() => ({}))) as { message?: string; project?: Project; createdIntentIds?: string[] };
    if (!response.ok || !body.project) {
      setScenePlanMessage(body.message || 'Could not create scene intents from beats.');
      setPlanningBusy(false);
      return;
    }

    onProjectChange(body.project);
    setScenePlanMessage(body.createdIntentIds && body.createdIntentIds.length > 0 ? `Created ${body.createdIntentIds.length} scene intent(s).` : 'No new scene intents were needed.');
    setPlanningBusy(false);
  }

  async function materializeSceneIntents(intentId?: string) {
    if (intentId) {
      setMaterializingIntentId(intentId);
    } else {
      setMaterializingAll(true);
    }
    setScenePlanMessage(intentId ? 'Materializing scene intent...' : 'Materializing approved scene intents...');

    const response = await fetch(`/api/projects/${project.id}/scene-intents/materialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: {
          ...project,
          explainer: {
            ...explainer,
            story: {
              ...explainer.story,
              beats
            },
            sceneIntents
          }
        },
        intentIds: intentId ? [intentId] : undefined
      })
    });

    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
      project?: Project;
      materialized?: Array<{ intentId: string; sceneId: string }>;
      skipped?: Array<{ intentId: string; sceneId: string }>;
    };

    if (!response.ok || !body.project) {
      setScenePlanMessage(body.message || 'Could not materialize scene intents.');
      setMaterializingIntentId(null);
      setMaterializingAll(false);
      return;
    }

    onProjectChange(body.project);
    if (body.materialized && body.materialized.length > 0) {
      setScenePlanMessage(`Materialized ${body.materialized.length} scene intent(s).`);
    } else if (body.skipped && body.skipped.length > 0) {
      setScenePlanMessage('Selected scene intents were already materialized.');
    } else {
      setScenePlanMessage('No scene intents were materialized.');
    }
    setMaterializingIntentId(null);
    setMaterializingAll(false);
  }

  return (
    <section className="space-y-6">
      <div className="studio-panel rounded-[28px] p-5 shadow-panel">
        <p className="font-mono text-[10px] uppercase tracking-[0.35em] text-slate-500">Explainer pre-production</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">Brief and Story Foundation</h2>
        <p className="mt-2 text-sm text-slate-300">
          Story/beats are source material. Scene narration remains production copy and does not auto-sync from script edits.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <section ref={briefSectionRef} className="studio-panel rounded-[28px] p-5 shadow-panel">
            <h3 className="text-lg font-semibold text-white">Brief</h3>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <Field
                label="Topic"
                value={explainer.brief.topic}
                onChange={(value) => update({ ...explainer, brief: { ...explainer.brief, topic: value } })}
              />
              <Field
                label="Goal"
                value={explainer.brief.goal}
                onChange={(value) => update({ ...explainer, brief: { ...explainer.brief, goal: value } })}
              />
              <Field
                label="Audience"
                value={explainer.brief.audience}
                onChange={(value) => update({ ...explainer, brief: { ...explainer.brief, audience: value } })}
              />
              <Field
                label="Tone"
                value={explainer.brief.tone}
                onChange={(value) => update({ ...explainer, brief: { ...explainer.brief, tone: value } })}
              />
              <Field
                label="Target duration (sec)"
                value={String(explainer.brief.targetDurationSeconds)}
                onChange={(value) => update({ ...explainer, brief: { ...explainer.brief, targetDurationSeconds: Number(value) || 1 } })}
                type="number"
              />
            </div>
            <div className="mt-4">
              <Field
                label="Notes"
                value={explainer.brief.notes ?? ''}
                onChange={(value) => update({ ...explainer, brief: { ...explainer.brief, notes: value } })}
                asTextArea
              />
            </div>
          </section>

          <section ref={storySectionRef} className="studio-panel rounded-[28px] p-5 shadow-panel">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">Story / Script</h3>
              <button
                type="button"
                onClick={snapshotScriptVersion}
                className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200"
              >
                Snapshot script version
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <Field
                label="Story title"
                value={explainer.story.title}
                onChange={(value) => update({ ...explainer, story: { ...explainer.story, title: value } })}
              />
              <Field
                label="Hook / opening"
                value={explainer.story.hook}
                onChange={(value) => update({ ...explainer, story: { ...explainer.story, hook: value } })}
                asTextArea
              />
              <Field
                label="Full script"
                value={explainer.story.script}
                onChange={(value) => update({ ...explainer, story: { ...explainer.story, script: value } })}
                asTextArea
                rows={10}
              />
              <Field
                label="CTA / end message"
                value={explainer.story.cta}
                onChange={(value) => update({ ...explainer, story: { ...explainer.story, cta: value } })}
                asTextArea
              />
              <Field
                label="Story notes"
                value={explainer.story.notes}
                onChange={(value) => update({ ...explainer, story: { ...explainer.story, notes: value } })}
                asTextArea
              />
            </div>
          </section>

          <section className="studio-panel rounded-[28px] p-5 shadow-panel">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">Beats</h3>
              <button type="button" onClick={addBeat} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200">
                Add beat
              </button>
            </div>
            <div className="mt-4 space-y-3">
              {beats.length === 0 ? <p className="text-sm text-slate-400">No beats yet.</p> : null}
              {beats.map((beat, index) => (
                <div key={beat.id} className="rounded-2xl border border-slate-700/70 bg-slate-950/30 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">Beat {beat.order}</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => moveBeat(beat.id, 'up')} disabled={index === 0} className="rounded-xl border border-slate-700 px-2 py-1 text-xs text-slate-200 disabled:opacity-40">Up</button>
                      <button type="button" onClick={() => moveBeat(beat.id, 'down')} disabled={index === beats.length - 1} className="rounded-xl border border-slate-700 px-2 py-1 text-xs text-slate-200 disabled:opacity-40">Down</button>
                      <button type="button" onClick={() => deleteBeat(beat.id)} className="rounded-xl border border-rose-400/40 px-2 py-1 text-xs text-rose-200">Delete</button>
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3">
                    <Field
                      label="Label"
                      value={beat.label ?? ''}
                      onChange={(value) => updateBeat(beat.id, { label: value })}
                    />
                    <Field
                      label="Beat text"
                      value={beat.text}
                      onChange={(value) => updateBeat(beat.id, { text: value })}
                      asTextArea
                      rows={4}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section ref={scenePlanSectionRef} className="studio-panel rounded-[28px] p-5 shadow-panel">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-white">Scene Plan</h3>
                <p className="mt-1 text-sm text-slate-300">Scene intents bridge story beats and production scenes. They stay free of asset, provider and render details.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={createSceneIntentsFromBeats} disabled={planningBusy} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200 disabled:opacity-60">
                  {planningBusy ? 'Planning...' : 'Create intents from beats'}
                </button>
                <button type="button" onClick={addSceneIntent} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200">
                  Add intent
                </button>
                <button
                  type="button"
                  onClick={() => void materializeSceneIntents()}
                  disabled={materializingAll || !sceneIntents.some((intent) => intent.status === 'approved')}
                  className="rounded-2xl bg-amber-300 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-60"
                >
                  {materializingAll ? 'Materializing...' : 'Materialize approved intents'}
                </button>
              </div>
            </div>

            {scenePlanMessage ? <p className="mt-3 text-sm text-slate-300">{scenePlanMessage}</p> : null}

            <div className="mt-4 space-y-3">
              {sceneIntents.length === 0 ? <p className="text-sm text-slate-400">No scene intents yet.</p> : null}
              {sceneIntents.map((intent, index) => {
                const linkedScene = intent.materializedSceneId ? project.scenes.find((scene) => scene.id === intent.materializedSceneId) : undefined;
                return (
                  <div key={intent.id} className="rounded-2xl border border-slate-700/70 bg-slate-950/30 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-mono text-xs uppercase tracking-[0.2em] text-slate-500">Intent {intent.order}</p>
                        <p className="mt-1 text-sm text-slate-300">Status: <span className={intent.status === 'approved' ? 'text-emerald-300' : 'text-amber-200'}>{intent.status}</span></p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => moveSceneIntent(intent.id, 'up')} disabled={index === 0} className="rounded-xl border border-slate-700 px-2 py-1 text-xs text-slate-200 disabled:opacity-40">Up</button>
                        <button type="button" onClick={() => moveSceneIntent(intent.id, 'down')} disabled={index === sceneIntents.length - 1} className="rounded-xl border border-slate-700 px-2 py-1 text-xs text-slate-200 disabled:opacity-40">Down</button>
                        <button type="button" onClick={() => updateSceneIntent(intent.id, { status: intent.status === 'approved' ? 'draft' : 'approved' })} className="rounded-xl border border-emerald-400/40 px-2 py-1 text-xs text-emerald-200">
                          {intent.status === 'approved' ? 'Mark draft' : 'Approve'}
                        </button>
                        <button type="button" onClick={() => deleteSceneIntent(intent.id)} className="rounded-xl border border-rose-400/40 px-2 py-1 text-xs text-rose-200">Delete</button>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <Field label="Label" value={intent.label ?? ''} onChange={(value) => updateSceneIntent(intent.id, { label: value })} />
                      <div className="space-y-1 text-sm text-slate-300">
                        <span className="block text-xs uppercase tracking-[0.2em] text-slate-500">Narrative role</span>
                        <select
                          value={intent.narrativeRole}
                          onChange={(event) => updateSceneIntent(intent.id, { narrativeRole: event.target.value as SceneIntentNarrativeRole })}
                          className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/35 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
                        >
                          {SCENE_INTENT_ROLES.map((role) => (
                            <option key={role} value={role}>{role}</option>
                          ))}
                        </select>
                      </div>
                      <Field label="Visual intent" value={intent.visualIntent} onChange={(value) => updateSceneIntent(intent.id, { visualIntent: value })} asTextArea rows={3} />
                      <Field label="Narration draft" value={intent.narrationDraft} onChange={(value) => updateSceneIntent(intent.id, { narrationDraft: value })} asTextArea rows={3} />
                      <Field
                        label="Timing intent (sec)"
                        value={String(intent.timing.durationSeconds)}
                        onChange={(value) => updateSceneIntent(intent.id, { timing: { durationSeconds: Number(value) || 1 } })}
                        type="number"
                      />
                      <Field label="Notes" value={intent.notes ?? ''} onChange={(value) => updateSceneIntent(intent.id, { notes: value })} asTextArea rows={3} />
                    </div>

                    <div className="mt-4 rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Beat links</p>
                      <div className="mt-3 grid gap-2 md:grid-cols-2">
                        {beats.length === 0 ? <p className="text-sm text-slate-400">No beats available yet.</p> : null}
                        {beats.map((beat) => {
                          const checked = intent.beatIds.includes(beat.id);
                          return (
                            <label key={beat.id} className="flex items-start gap-2 rounded-xl border border-slate-700/60 bg-slate-950/20 p-2 text-sm text-slate-200">
                              <input type="checkbox" checked={checked} onChange={() => toggleIntentBeat(intent.id, beat.id)} className="mt-1" />
                              <span>
                                <span className="block text-xs text-slate-400">Beat {beat.order}{beat.label ? ` • ${beat.label}` : ''}</span>
                                <span className="block text-slate-200">{beat.text}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void materializeSceneIntents(intent.id)}
                        disabled={materializingIntentId === intent.id || intent.status !== 'approved'}
                        className="rounded-2xl border border-amber-300/40 bg-amber-200/10 px-3 py-2 text-xs text-amber-100 disabled:opacity-60"
                      >
                        {materializingIntentId === intent.id ? 'Materializing...' : 'Materialize to Scene'}
                      </button>
                      {linkedScene ? (
                        <button type="button" onClick={() => onOpenScene(linkedScene.id)} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200">
                          Open Scene {linkedScene.order}
                        </button>
                      ) : null}
                      {linkedScene ? <span className="text-xs text-emerald-300">Materialized as scene {linkedScene.order}</span> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <aside className="space-y-6">
          <section className="studio-panel rounded-[28px] p-5 shadow-panel">
            <h3 className="text-lg font-semibold text-white">Script versions</h3>
            <div className="mt-4 space-y-3">
              {explainer.story.versions.length === 0 ? <p className="text-sm text-slate-400">No script snapshots yet.</p> : null}
              {explainer.story.versions.map((version) => (
                <div key={version.id} className="rounded-2xl border border-slate-700/70 bg-slate-950/30 p-3">
                  <p className="text-xs text-slate-400">{new Date(version.createdAt).toLocaleString()} • {version.source}</p>
                  <p className="mt-2 whitespace-pre-line text-sm text-slate-200">{version.script}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="studio-panel rounded-[28px] p-5 shadow-panel">
            <h3 className="text-lg font-semibold text-white">Navigate production surfaces</h3>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => onNavigateToTab('scenes')} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200">Open Scenes</button>
              <button type="button" onClick={() => onNavigateToTab('assets')} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200">Open Assets</button>
              <button type="button" onClick={() => onNavigateToTab('references')} className="rounded-2xl border border-slate-700 bg-slate-950/50 px-3 py-2 text-xs text-slate-200">Open References</button>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  asTextArea = false,
  rows = 3
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number';
  asTextArea?: boolean;
  rows?: number;
}) {
  return (
    <label className="space-y-1 text-sm text-slate-300">
      <span className="block text-xs uppercase tracking-[0.2em] text-slate-500">{label}</span>
      {asTextArea ? (
        <textarea
          value={value}
          rows={rows}
          onChange={(event) => onChange(event.target.value)}
          className="min-h-20 w-full rounded-2xl border border-slate-700/70 bg-slate-950/35 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="w-full rounded-2xl border border-slate-700/70 bg-slate-950/35 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-amber-300/50"
        />
      )}
    </label>
  );
}
