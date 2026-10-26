import { requireHumanApprovalForMode } from '@/lib/explainer/human-approval';
import {
  MandateStoreError,
  readProjectMandate,
  requireLiveProjectMandate,
  resolveMandateStatus
} from '@/lib/storage/mandate-store';
import type { ProductionMandate } from '@/lib/types/mandate';
import type { Project } from '@/lib/types/render';
import { AccessControlError } from './access-control';
import type { RequestIdentity } from './auth';

export function mandateErrorToAccessControl(error: MandateStoreError): AccessControlError {
  const status = error.status === 404 ? 404 : 403;
  const code = status === 404 ? 'NOT_FOUND' : 'FORBIDDEN';
  return new AccessControlError(error.message, code, status, { mandateCode: error.code });
}

export async function requireServiceMandate(projectId: string): Promise<ProductionMandate> {
  try {
    return await requireLiveProjectMandate(projectId);
  } catch (error) {
    if (error instanceof MandateStoreError) {
      throw mandateErrorToAccessControl(error);
    }
    throw error;
  }
}

export async function assertAuthorizedRealActor(
  mode: string | undefined,
  identity: RequestIdentity | undefined,
  projectId?: string
): Promise<void> {
  if (mode !== 'real') {
    return;
  }

  if (identity?.kind === 'user') {
    return;
  }

  if (identity?.kind === 'service') {
    if (!projectId?.trim()) {
      throw new AccessControlError('A production mandate is required for real or paid execution.', 'FORBIDDEN', 403);
    }
    await requireServiceMandate(projectId);
    return;
  }

  if (!projectId?.trim()) {
    return;
  }

  const mandate = await readProjectMandate(projectId);
  if (!mandate) {
    return;
  }

  const status = resolveMandateStatus(mandate);
  if (status === 'revoked' || status === 'expired' || status === 'failed') {
    throw new AccessControlError(
      'The production mandate is no longer valid. New paid actions are not authorized.',
      'FORBIDDEN',
      403,
      { mandateCode: status === 'revoked' ? 'MANDATE_REVOKED' : status === 'failed' ? 'MANDATE_FAILED' : 'MANDATE_EXPIRED' }
    );
  }
}

export async function assertRealExecutionAuthorized(
  project: Project,
  mode: string | undefined,
  identity: RequestIdentity | undefined
): Promise<void> {
  await assertAuthorizedRealActor(mode, identity, project.id);

  if (mode !== 'real') {
    return;
  }

  if (identity?.kind === 'service') {
    return;
  }

  if (!identity) {
    const mandate = await readProjectMandate(project.id);
    if (mandate) {
      const status = resolveMandateStatus(mandate);
      if (status === 'revoked' || status === 'expired' || status === 'failed') {
        throw new AccessControlError(
          'The production mandate is no longer valid. New paid actions are not authorized.',
          'FORBIDDEN',
          403,
          { mandateCode: status === 'revoked' ? 'MANDATE_REVOKED' : status === 'failed' ? 'MANDATE_FAILED' : 'MANDATE_EXPIRED' }
        );
      }
      if (status === 'active' || (status === 'consumed' && mandate.boundRunId)) {
        return;
      }
    }
  }

  requireHumanApprovalForMode(project, mode);
}
