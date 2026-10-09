import { createId } from '@/lib/utils/ids';
import type { Project } from '@/lib/types/render';
import type { SceneIntentDraft, StoryBeat } from '@/lib/types/explainer';

export interface SceneIntentPlanningResult {
  project: Project;
  createdIntentIds: string[];
}

function beatAlreadyLinked(sceneIntents: SceneIntentDraft[], beatId: string): boolean {
  return sceneIntents.some((intent) => intent.beatIds.includes(beatId));
}

function createIntentFromBeat(beat: StoryBeat): SceneIntentDraft {
  return {
    id: createId('scene_intent'),
    order: beat.order,
    beatIds: [beat.id],
    label: beat.label || `Intent ${beat.order}`,
    narrativeRole: beat.order === 1 ? 'hook' : 'explanation',
    visualIntent: '',
    narrationDraft: beat.text,
    timing: {
      durationSeconds: 5
    },
    notes: '',
    status: 'draft'
  };
}

function reindex(intents: SceneIntentDraft[]): SceneIntentDraft[] {
  return intents
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((intent, index) => ({ ...intent, order: index + 1 }));
}

export function planSceneIntentsFromBeats(project: Project): SceneIntentPlanningResult {
  const beats = project.explainer?.story.beats ?? [];
  const sceneIntents = project.explainer?.sceneIntents ?? [];
  const created: SceneIntentDraft[] = [];

  for (const beat of beats.slice().sort((a, b) => a.order - b.order)) {
    if (beatAlreadyLinked(sceneIntents, beat.id)) {
      continue;
    }
    created.push(createIntentFromBeat(beat));
  }

  const nextSceneIntents = reindex([
    ...sceneIntents,
    ...created.map((intent, index) => ({ ...intent, order: sceneIntents.length + index + 1 }))
  ]);

  return {
    project: {
      ...project,
      explainer: {
        ...project.explainer!,
        sceneIntents: nextSceneIntents
      }
    },
    createdIntentIds: created.map((intent) => intent.id)
  };
}
