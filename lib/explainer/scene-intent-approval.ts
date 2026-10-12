import type { Project } from '@/lib/types/render';

export class SceneIntentApprovalError extends Error {
  readonly code: 'INTENT_NOT_FOUND';

  constructor(message: string, code: 'INTENT_NOT_FOUND' = 'INTENT_NOT_FOUND') {
    super(message);
    this.name = 'SceneIntentApprovalError';
    this.code = code;
  }
}

export interface SceneIntentApprovalResult {
  project: Project;
  approved: string[];
  skipped: string[];
}

/**
 * Approves scene intents so they become eligible for materialization.
 *
 * - With no `intentIds`, every intent that is not yet approved is approved.
 * - With `intentIds`, only those intents are approved; an unknown id is a hard
 *   error (`INTENT_NOT_FOUND`) so callers cannot silently approve nothing.
 * - Intents that are already approved are reported under `skipped` (idempotent).
 *
 * This is an explicit status transition only; it never materializes scenes and
 * never approves anything implicitly.
 */
export function approveSceneIntents(project: Project, intentIds?: string[]): SceneIntentApprovalResult {
  const intents = project.explainer?.sceneIntents ?? [];
  const byId = new Map(intents.map((intent) => [intent.id, intent]));

  const requestedIds = Array.isArray(intentIds) && intentIds.length > 0
    ? Array.from(new Set(intentIds))
    : intents.map((intent) => intent.id);

  for (const intentId of requestedIds) {
    if (!byId.has(intentId)) {
      throw new SceneIntentApprovalError(`Scene intent ${intentId} not found.`, 'INTENT_NOT_FOUND');
    }
  }

  const approved: string[] = [];
  const skipped: string[] = [];
  const nextIntents = intents.map((intent) => {
    if (!requestedIds.includes(intent.id)) {
      return { ...intent, beatIds: intent.beatIds.slice() };
    }

    if (intent.status === 'approved') {
      skipped.push(intent.id);
      return { ...intent, beatIds: intent.beatIds.slice() };
    }

    approved.push(intent.id);
    return { ...intent, beatIds: intent.beatIds.slice(), status: 'approved' as const };
  });

  return {
    project: {
      ...project,
      ...(project.explainer
        ? {
            explainer: {
              ...project.explainer,
              sceneIntents: nextIntents
            }
          }
        : {})
    },
    approved,
    skipped
  };
}
