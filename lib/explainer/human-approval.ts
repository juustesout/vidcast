import { createHash } from 'node:crypto';

import type { HumanProductionApproval, SceneIntentApproval, SceneIntentDraft } from '@/lib/types/explainer';
import type { Project } from '@/lib/types/render';
import type { Scene, VisualSpec } from '@/lib/types/scene';

export class HumanApprovalError extends Error {
  readonly code: 'HUMAN_APPROVAL_REQUIRED' | 'HUMAN_APPROVAL_STALE';
  readonly status: 403;

  constructor(message: string, code: 'HUMAN_APPROVAL_REQUIRED' | 'HUMAN_APPROVAL_STALE' = 'HUMAN_APPROVAL_REQUIRED') {
    super(message);
    this.name = 'HumanApprovalError';
    this.code = code;
    this.status = 403;
  }
}

export interface ApprovalActor {
  subject: string;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stable);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stable((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function visualFingerprint(visual: VisualSpec | undefined): unknown {
  if (!visual) {
    return null;
  }

  switch (visual.kind) {
    case 'blank':
      return { kind: 'blank' };
    case 'asset':
      return { kind: 'asset', assetId: visual.assetId ?? null };
    case 'text':
      return { kind: 'text', text: visual.text };
    case 'generated_image':
      return {
        kind: 'generated_image',
        prompt: visual.generation?.prompt ?? '',
        model: visual.generation?.model ?? null,
        provider: visual.generation?.provider ?? null
      };
    case 'generated_video':
      return {
        kind: 'generated_video',
        prompt: visual.generation?.prompt ?? '',
        model: visual.generation?.model ?? null,
        provider: visual.generation?.provider ?? null
      };
    case 'stock_image':
      return {
        kind: 'stock_image',
        query: visual.query,
        orientation: visual.orientation ?? null
      };
    case 'graphic':
      return {
        kind: 'graphic',
        template: visual.template ?? null,
        prompt: visual.prompt ?? null,
        templateData: visual.templateData ?? null
      };
    case 'html':
      return {
        kind: 'html',
        template: visual.template ?? null,
        templateData: visual.templateData ?? null
      };
    default:
      return { kind: (visual as { kind?: string }).kind ?? 'unknown' };
  }
}

export function hashIntentContent(intent: Pick<
  SceneIntentDraft,
  'id' | 'order' | 'beatIds' | 'label' | 'narrativeRole' | 'visualIntent' | 'narrationDraft' | 'timing' | 'notes'
>): string {
  return sha256({
    id: intent.id,
    order: intent.order,
    beatIds: intent.beatIds,
    label: intent.label ?? '',
    narrativeRole: intent.narrativeRole,
    visualIntent: intent.visualIntent,
    narrationDraft: intent.narrationDraft,
    durationSeconds: intent.timing.durationSeconds,
    notes: intent.notes ?? ''
  });
}

function sceneFingerprint(scene: Scene): unknown {
  return {
    id: scene.id,
    order: scene.order,
    duration: scene.duration,
    type: scene.type,
    narrationText: scene.narration?.text ?? '',
    visual: visualFingerprint(scene.visual)
  };
}

export function hashProductionContent(project: Project): string {
  const intents = (project.explainer?.sceneIntents ?? []).map((intent) => ({
    id: intent.id,
    order: intent.order,
    beatIds: intent.beatIds,
    label: intent.label ?? '',
    narrativeRole: intent.narrativeRole,
    visualIntent: intent.visualIntent,
    narrationDraft: intent.narrationDraft,
    durationSeconds: intent.timing.durationSeconds,
    notes: intent.notes ?? ''
  }));

  return sha256({
    intents,
    scenes: project.scenes.map(sceneFingerprint),
    presenter: project.presenter
      ? {
          enabled: project.presenter.enabled === true,
          provider: project.presenter.provider ?? null,
          maxCostUsd: project.presenter.maxCostUsd ?? null
        }
      : null
  });
}

export function isValidIntentApproval(intent: SceneIntentDraft): boolean {
  if (intent.status !== 'approved' || !intent.approval) {
    return false;
  }
  return intent.approval.contentHash === hashIntentContent(intent) && intent.approval.approvedBy.trim().length > 0;
}

export function isValidHumanApproval(project: Project): boolean {
  const approval = project.explainer?.humanApproval;
  if (!approval?.approvedBy?.trim() || !approval.contentHash) {
    return false;
  }
  return approval.contentHash === hashProductionContent(project);
}

export function requireHumanApprovalForMode(project: Project, mode: string | undefined): void {
  if (mode === 'real') {
    assertHumanApprovalForRealExecution(project);
  }
}

export function assertHumanApprovalForRealExecution(project: Project): void {
  if (!project.explainer?.humanApproval) {
    throw new HumanApprovalError(
      'A human must approve the current project snapshot before real or paid execution.',
      'HUMAN_APPROVAL_REQUIRED'
    );
  }

  if (!isValidHumanApproval(project)) {
    throw new HumanApprovalError(
      'Human approval is no longer valid for the current project content. Re-approve before real or paid execution.',
      'HUMAN_APPROVAL_STALE'
    );
  }
}

export function stampHumanApproval(project: Project, actor: ApprovalActor, approvedAt = new Date().toISOString()): HumanProductionApproval {
  return {
    approvedBy: actor.subject,
    approvedAt,
    contentHash: hashProductionContent(project)
  };
}

export function stampIntentApproval(intent: SceneIntentDraft, actor: ApprovalActor, approvedAt = new Date().toISOString()): SceneIntentApproval {
  return {
    approvedBy: actor.subject,
    approvedAt,
    contentHash: hashIntentContent(intent)
  };
}

function cloneIntent(intent: SceneIntentDraft): SceneIntentDraft {
  return {
    ...intent,
    beatIds: intent.beatIds.slice(),
    timing: { ...intent.timing },
    approval: intent.approval ? { ...intent.approval } : undefined
  };
}

export function reconcileServerOwnedApprovals(existing: Project, candidate: Project): Project {
  const existingIntents = new Map((existing.explainer?.sceneIntents ?? []).map((intent) => [intent.id, intent]));
  const incomingExplainer = candidate.explainer;
  if (!incomingExplainer) {
    return candidate;
  }

  const nextIntents = incomingExplainer.sceneIntents.map((intent) => {
    const incoming = cloneIntent(intent);
    const previous = existingIntents.get(intent.id);
    const contentHash = hashIntentContent(incoming);
    const incomingUnapprove = incoming.status === 'draft';

    if (incomingUnapprove) {
      return {
        ...incoming,
        status: 'draft' as const,
        approval: undefined
      };
    }

    if (previous && previous.status === 'approved' && hashIntentContent(previous) === contentHash) {
      return {
        ...incoming,
        status: 'approved' as const,
        approval: previous.approval ? { ...previous.approval } : undefined
      };
    }

    return {
      ...incoming,
      status: 'draft' as const,
      approval: undefined
    };
  });

  const nextProject: Project = {
    ...candidate,
    explainer: {
      ...incomingExplainer,
      sceneIntents: nextIntents,
      humanApproval: undefined
    }
  };

  const previousApproval = existing.explainer?.humanApproval;
  if (previousApproval && previousApproval.contentHash === hashProductionContent(nextProject) && previousApproval.approvedBy.trim()) {
    nextProject.explainer = {
      ...nextProject.explainer!,
      humanApproval: { ...previousApproval }
    };
  }

  return nextProject;
}
