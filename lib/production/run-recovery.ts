import type { GenerationStatus } from '@/lib/types/generation';
import type { Project } from '@/lib/types/render';
import type { ProductionActionType } from './production-planner';
import type { RunMode } from './run-types';

export interface RecoveryNote {
  message: string;
  sceneId?: string;
  actionType?: ProductionActionType;
}

export interface RecoveryReconciliationResult {
  // Null when nothing needed to change.
  updatedProject: Project | null;
  // Action ids that must not be auto-retried (real-mode interrupted work).
  suppressedActionIds: string[];
  notes: RecoveryNote[];
}

function sceneActionId(type: ProductionActionType, sceneId: string): string {
  return `scene:${sceneId}:${type}`;
}

function isActiveStatus(status: GenerationStatus): boolean {
  return status === 'queued' || status === 'generating';
}

function hasUsableAsset(project: Project, assetId: string | undefined): boolean {
  if (!assetId) {
    return false;
  }
  const asset = project.assets.find((entry) => entry.id === assetId);
  return Boolean(asset && asset.status === 'available');
}

// Normalizes generation state that was interrupted by a process restart so the
// planner can re-derive a runnable plan:
//  - active video attempt with a provider job id: left untouched, resumed by poll;
//  - active attempt with a usable persisted asset: restored to `generated`;
//  - active attempt without either: marked `failed`.
// In real mode, an interrupted attempt that cannot be resumed is also suppressed
// (by action id) so the run surfaces it as failed instead of silently re-billing.
export function reconcileInterruptedGenerations(project: Project, mode: RunMode): RecoveryReconciliationResult {
  const suppressedActionIds: string[] = [];
  const notes: RecoveryNote[] = [];
  let changed = false;

  const scenes = project.scenes.map((scene) => {
    let nextScene = scene;
    let sceneChanged = false;

    if (scene.visual && (scene.visual.kind === 'generated_image' || scene.visual.kind === 'generated_video')) {
      const visual = scene.visual;
      const generation = visual.generation;

      if (isActiveStatus(generation.status)) {
        const assetId = visual.assetId ?? generation.assetId;
        const actionType: ProductionActionType = visual.kind === 'generated_image' ? 'image_generate' : 'video_submit';

        if (visual.kind === 'generated_video' && generation.providerJobId) {
          notes.push({
            sceneId: scene.id,
            actionType: 'video_poll',
            message: `Resuming stored video generation job for scene ${scene.order}.`
          });
        } else if (hasUsableAsset(project, assetId)) {
          sceneChanged = true;
          notes.push({
            sceneId: scene.id,
            actionType,
            message: `Restored interrupted generation for scene ${scene.order} from an existing asset.`
          });
          nextScene = {
            ...nextScene,
            visual: {
              ...visual,
              assetId,
              generation: {
                ...generation,
                status: 'generated' as const,
                error: undefined,
                errorCode: undefined,
                errorMessage: undefined
              }
            }
          };
        } else {
          sceneChanged = true;
          notes.push({
            sceneId: scene.id,
            actionType,
            message: `Interrupted generation for scene ${scene.order} has no recoverable job; marked as failed.`
          });
          if (mode === 'real') {
            suppressedActionIds.push(sceneActionId(actionType, scene.id));
          }
          nextScene = {
            ...nextScene,
            visual: {
              ...visual,
              assetId,
              generation: {
                ...generation,
                status: 'failed' as const
              }
            }
          };
        }
      }
    }

    if (nextScene.narration && nextScene.narration.status === 'generating') {
      const narration = nextScene.narration;
      const lastAttemptId = narration.lastAttemptId;
      const attempts = (narration.attempts ?? []).map((attempt) =>
        attempt.id === lastAttemptId && attempt.status === 'generating'
          ? { ...attempt, status: 'failed' as const, error: attempt.error ?? 'Interrupted by process restart.' }
          : attempt
      );

      if (hasUsableAsset(project, narration.audioAssetId)) {
        sceneChanged = true;
        notes.push({
          sceneId: scene.id,
          actionType: 'narration_generate',
          message: `Restored interrupted narration for scene ${scene.order} from an existing asset.`
        });
        nextScene = {
          ...nextScene,
          narration: { ...narration, status: 'generated' as const, error: undefined, attempts }
        };
      } else {
        sceneChanged = true;
        notes.push({
          sceneId: scene.id,
          actionType: 'narration_generate',
          message: `Interrupted narration for scene ${scene.order} has no recoverable job; marked as failed.`
        });
        if (mode === 'real') {
          suppressedActionIds.push(sceneActionId('narration_generate', scene.id));
        }
        nextScene = {
          ...nextScene,
          narration: { ...narration, status: 'failed' as const, error: 'Interrupted by process restart.', attempts }
        };
      }
    }

    if (sceneChanged) {
      changed = true;
    }
    return nextScene;
  });

  let updatedProject: Project | null = changed ? { ...project, scenes } : null;

  // Project-level background music is not a production-run action, but an
  // interrupted generation must not leave the project permanently stuck in
  // `generating` (which would block all future music generation).
  if (project.music?.status === 'generating') {
    const base = updatedProject ?? project;
    const lastAttemptId = project.music.lastAttemptId;
    const attempts = (project.music.attempts ?? []).map((attempt) =>
      attempt.id === lastAttemptId && attempt.status === 'generating'
        ? { ...attempt, status: 'failed' as const, error: attempt.error ?? 'Interrupted by process restart.' }
        : attempt
    );

    if (hasUsableAsset(project, project.music.assetId)) {
      notes.push({ message: 'Restored interrupted background music generation from an existing asset.' });
      updatedProject = {
        ...base,
        music: { ...project.music, status: 'generated' as const, error: undefined, attempts }
      };
    } else {
      notes.push({ message: 'Interrupted background music generation has no recoverable asset; marked as failed.' });
      updatedProject = {
        ...base,
        music: { ...project.music, status: 'failed' as const, error: 'Interrupted by process restart.', attempts }
      };
    }
  }

  return {
    updatedProject,
    suppressedActionIds,
    notes
  };
}
