import type { Project } from '@/lib/types/render';
import {
  hashProductionContent,
  stampHumanApproval,
  stampIntentApproval,
  type ApprovalActor
} from './human-approval';

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
 * - Intents that are already approved for the current content are reported
 *   under `skipped` (idempotent).
 *
 * This is an explicit status transition only; it never materializes scenes and
 * never approves anything implicitly. Callers must supply a human actor; the
 * API layer refuses service identity before this function runs.
 */
export function approveSceneIntents(
  project: Project,
  intentIds?: string[],
  actor: ApprovalActor = { subject: 'user' }
): SceneIntentApprovalResult {
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

  const approvedAt = new Date().toISOString();
  const approved: string[] = [];
  const skipped: string[] = [];
  const nextIntents = intents.map((intent) => {
    const cloned = { ...intent, beatIds: intent.beatIds.slice(), timing: { ...intent.timing } };
    if (!requestedIds.includes(intent.id)) {
      return cloned;
    }

    if (cloned.status === 'approved') {
      skipped.push(intent.id);
      return cloned;
    }

    approved.push(intent.id);
    return {
      ...cloned,
      status: 'approved' as const,
      approval: stampIntentApproval(cloned, actor, approvedAt)
    };
  });

  const nextProject: Project = {
    ...project,
    ...(project.explainer
      ? {
          explainer: {
            ...project.explainer,
            sceneIntents: nextIntents
          }
        }
      : {})
  };

  if (nextProject.explainer) {
    const previous = nextProject.explainer.humanApproval;
    const contentHash = hashProductionContent(nextProject);
    nextProject.explainer = {
      ...nextProject.explainer,
      humanApproval:
        previous && previous.contentHash === contentHash && previous.approvedBy === actor.subject
          ? previous
          : stampHumanApproval(nextProject, actor, approvedAt)
    };
  }

  return {
    project: nextProject,
    approved,
    skipped
  };
}
