import { createId } from '@/lib/utils/ids';
import type { Project } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';

export class SceneIntentMaterializationError extends Error {
  readonly code:
    | 'INTENT_NOT_FOUND'
    | 'INTENT_NOT_APPROVED'
    | 'INTENT_ALREADY_MATERIALIZED'
    | 'INTENT_INVALID_BEAT_REFERENCE'
    | 'INTENT_TARGET_SCENE_MISSING';

  constructor(
    message: string,
    code:
      | 'INTENT_NOT_FOUND'
      | 'INTENT_NOT_APPROVED'
      | 'INTENT_ALREADY_MATERIALIZED'
      | 'INTENT_INVALID_BEAT_REFERENCE'
      | 'INTENT_TARGET_SCENE_MISSING'
  ) {
    super(message);
    this.name = 'SceneIntentMaterializationError';
    this.code = code;
  }
}

export interface SceneIntentMaterializationResult {
  project: Project;
  materialized: Array<{ intentId: string; sceneId: string }>;
  skipped: Array<{ intentId: string; sceneId: string }>;
}

function buildSceneNotes(visualIntent: string, notes: string | undefined): string {
  const parts = [] as string[];
  if (visualIntent.trim()) {
    parts.push(`Visual intent: ${visualIntent.trim()}`);
  }
  if (notes?.trim()) {
    parts.push(notes.trim());
  }
  return parts.join('\n\n');
}

function createSceneFromIntent(project: Project, intentId: string, nextOrder: number): Scene {
  const intent = project.explainer!.sceneIntents.find((entry) => entry.id === intentId);
  if (!intent) {
    throw new SceneIntentMaterializationError(`Scene intent ${intentId} not found.`, 'INTENT_NOT_FOUND');
  }

  if (intent.status !== 'approved') {
    throw new SceneIntentMaterializationError(`Scene intent ${intentId} is not approved.`, 'INTENT_NOT_APPROVED');
  }

  const beats = project.explainer!.story.beats;
  for (const beatId of intent.beatIds) {
    if (!beats.some((beat) => beat.id === beatId)) {
      throw new SceneIntentMaterializationError(`Scene intent ${intentId} references a missing beat ${beatId}.`, 'INTENT_INVALID_BEAT_REFERENCE');
    }
  }

  return {
    id: createId('scene'),
    order: nextOrder,
    duration: intent.timing.durationSeconds,
    source: {
      sceneIntentId: intent.id,
      beatIds: intent.beatIds.slice()
    },
    type: 'blank',
    narration: {
      text: intent.narrationDraft
    },
    visual: {
      kind: 'blank'
    },
    render: {
      motion: { preset: 'none' },
      transition: { type: 'fade' }
    },
    overlay: {
      type: 'none'
    },
    referenceIds: [],
    notes: buildSceneNotes(intent.visualIntent, intent.notes),
    renders: []
  };
}

export function materializeSceneIntents(project: Project, intentIds?: string[]): SceneIntentMaterializationResult {
  const intents = project.explainer?.sceneIntents ?? [];
  const targetIds = intentIds && intentIds.length > 0
    ? intentIds
    : intents.filter((intent) => intent.status === 'approved').map((intent) => intent.id);

  const materialized: Array<{ intentId: string; sceneId: string }> = [];
  const skipped: Array<{ intentId: string; sceneId: string }> = [];
  let nextOrder = project.scenes.reduce((max, scene) => Math.max(max, scene.order), 0);
  const nextProject: Project = {
    ...project,
    scenes: project.scenes.slice(),
    explainer: {
      ...project.explainer!,
      sceneIntents: project.explainer!.sceneIntents.map((intent) => ({ ...intent, beatIds: intent.beatIds.slice() }))
    }
  };

  for (const intentId of targetIds) {
    const intent = nextProject.explainer!.sceneIntents.find((entry) => entry.id === intentId);
    if (!intent) {
      throw new SceneIntentMaterializationError(`Scene intent ${intentId} not found.`, 'INTENT_NOT_FOUND');
    }

    if (intent.materializedSceneId) {
      const scene = nextProject.scenes.find((entry) => entry.id === intent.materializedSceneId);
      if (!scene) {
        throw new SceneIntentMaterializationError(`Scene intent ${intent.id} points to missing scene ${intent.materializedSceneId}.`, 'INTENT_TARGET_SCENE_MISSING');
      }
      skipped.push({ intentId: intent.id, sceneId: scene.id });
      continue;
    }

    nextOrder += 1;
    const scene = createSceneFromIntent(nextProject, intent.id, nextOrder);
    nextProject.scenes.push(scene);
    intent.materializedSceneId = scene.id;
    materialized.push({ intentId: intent.id, sceneId: scene.id });
  }

  return {
    project: nextProject,
    materialized,
    skipped
  };
}
