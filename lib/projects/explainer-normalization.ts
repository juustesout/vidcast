import type { ExplainerSpec, SceneIntentNarrativeRole, SceneIntentStatus, StoryBeat, StoryScriptVersion } from '@/lib/types/explainer';
import type { Project, ProjectNarration } from '@/lib/types/render';
import { createId } from '@/lib/utils/ids';

function nowIso(): string {
  return new Date().toISOString();
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clampDuration(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.round(value);
}

function normalizeVersions(input: unknown): StoryScriptVersion[] {
  const raw = Array.isArray(input) ? input : [];
  const normalized: StoryScriptVersion[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Partial<StoryScriptVersion>;
    const script = asString(record.script);
    if (!script.trim()) {
      continue;
    }

    normalized.push({
      id: typeof record.id === 'string' && record.id.trim() ? record.id : createId('script_version'),
      script,
      createdAt: typeof record.createdAt === 'string' && record.createdAt.trim() ? record.createdAt : nowIso(),
      source: record.source === 'ai' ? 'ai' : 'manual'
    });
  }

  return normalized;
}

function normalizeBeats(input: unknown, fallbackFromNarration: ProjectNarration): StoryBeat[] {
  const raw = Array.isArray(input) ? input : [];
  const normalized: StoryBeat[] = raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry, index) => ({
      id: typeof entry.id === 'string' && entry.id.trim() ? entry.id : createId('beat'),
      order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : index + 1,
      label: typeof entry.label === 'string' ? entry.label : undefined,
      text: asString(entry.text)
    }))
    .sort((a, b) => a.order - b.order)
    .map((beat, index) => ({ ...beat, order: index + 1 }));

  if (normalized.length > 0) {
    return normalized;
  }

  return fallbackFromNarration.segments
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((segment, index) => ({
      id: segment.id || createId('beat'),
      order: index + 1,
      label: `Beat ${index + 1}`,
      text: segment.text
    }));
}

function normalizeNarrativeRole(value: unknown): SceneIntentNarrativeRole {
  if (value === 'hook' || value === 'setup' || value === 'explanation' || value === 'example' || value === 'transition' || value === 'summary' || value === 'cta' || value === 'custom') {
    return value;
  }
  return 'explanation';
}

function normalizeIntentStatus(value: unknown): SceneIntentStatus {
  return value === 'approved' ? 'approved' : 'draft';
}

export function normalizeExplainer(project: Project): ExplainerSpec {
  const legacyNarrationText = project.narration?.text ?? '';
  const current = project.explainer;
  const beats = normalizeBeats(current?.story?.beats, project.narration);
  const script = asString(current?.story?.script) || legacyNarrationText;
  const versions = normalizeVersions(current?.story?.versions);

  return {
    brief: {
      topic: asString(current?.brief?.topic),
      goal: asString(current?.brief?.goal),
      audience: asString(current?.brief?.audience),
      tone: asString(current?.brief?.tone),
      targetDurationSeconds: clampDuration(current?.brief?.targetDurationSeconds, project.durationTarget),
      notes: asString(current?.brief?.notes)
    },
    story: {
      title: asString(current?.story?.title) || project.title,
      hook: asString(current?.story?.hook),
      script,
      beats,
      cta: asString(current?.story?.cta),
      notes: asString(current?.story?.notes),
      versions
    },
    sceneIntents: Array.isArray(current?.sceneIntents)
      ? current.sceneIntents
          .filter((entry) => Boolean(entry) && typeof entry === 'object')
          .map((entry, index) => ({
            id: typeof (entry as { id?: unknown }).id === 'string' && (entry as { id: string }).id.trim() ? (entry as { id: string }).id : createId('scene_intent'),
            order: typeof (entry as { order?: unknown }).order === 'number' && Number.isFinite((entry as { order: number }).order) ? (entry as { order: number }).order : index + 1,
            beatIds: Array.isArray((entry as { beatIds?: unknown }).beatIds)
              ? ((entry as { beatIds: unknown[] }).beatIds.filter((beatId): beatId is string => typeof beatId === 'string' && beatId.trim().length > 0))
              : typeof (entry as { beatId?: unknown }).beatId === 'string'
                ? [((entry as unknown as { beatId: string }).beatId)]
                : [],
            label: typeof (entry as { label?: unknown }).label === 'string' ? (entry as { label: string }).label : undefined,
            narrativeRole: normalizeNarrativeRole((entry as { narrativeRole?: unknown }).narrativeRole),
            visualIntent: asString((entry as { visualIntent?: unknown }).visualIntent),
            narrationDraft: asString((entry as { narrationDraft?: unknown }).narrationDraft),
            timing: {
              durationSeconds: clampDuration((entry as { timing?: { durationSeconds?: unknown } }).timing?.durationSeconds, 5)
            },
            notes: typeof (entry as { notes?: unknown }).notes === 'string' ? (entry as { notes: string }).notes : undefined,
            status: normalizeIntentStatus((entry as { status?: unknown }).status),
            materializedSceneId: typeof (entry as { materializedSceneId?: unknown }).materializedSceneId === 'string' ? (entry as { materializedSceneId: string }).materializedSceneId : undefined
          }))
          .sort((a, b) => a.order - b.order)
          .map((entry, index) => ({ ...entry, order: index + 1 }))
      : []
  };
}
