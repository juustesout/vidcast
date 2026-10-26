import { NextResponse } from 'next/server';

import { AccessControlError, requireProjectAccess } from '@/lib/security/access-control';
import { toAccessControlResponse } from '@/lib/security/http-response';
import {
  MandateStoreError,
  createProjectMandate,
  isMandateLive,
  publicMandateView,
  readProjectMandate,
  resolveMandateStatus,
  revokeProjectMandate
} from '@/lib/storage/mandate-store';
import {
  DEFAULT_MANDATE_TTL_MS,
  MAX_MANDATE_TTL_MS,
  MIN_MANDATE_TTL_MS,
  MANDATE_ACTIONS,
  type MandateAction,
  type MandateBudgetSettings,
  type MandateProviderAllowlist
} from '@/lib/types/mandate';

interface RouteContext {
  params: Promise<{ id: string }>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseAllowedActions(value: unknown): MandateAction[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is MandateAction => typeof entry === 'string' && (MANDATE_ACTIONS as string[]).includes(entry));
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function parseBudgets(value: unknown): MandateBudgetSettings | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  return {
    maxSubmits: parsePositiveInt(value.maxSubmits),
    maxImageSubmits: parsePositiveInt(value.maxImageSubmits),
    maxVideoSubmits: parsePositiveInt(value.maxVideoSubmits),
    maxNarrationSubmits: parsePositiveInt(value.maxNarrationSubmits),
    maxMusicSubmits: parsePositiveInt(value.maxMusicSubmits),
    maxPresenterSubmits: parsePositiveInt(value.maxPresenterSubmits),
    maxCostUsd: typeof value.maxCostUsd === 'number' && Number.isFinite(value.maxCostUsd) && value.maxCostUsd > 0 ? value.maxCostUsd : undefined
  };
}

function parseAllowedProviders(value: unknown): MandateProviderAllowlist | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const asList = (input: unknown): string[] | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }
    const items = input.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim());
    return items.length > 0 ? Array.from(new Set(items)) : undefined;
  };
  return {
    image: asList(value.image) as MandateProviderAllowlist['image'],
    video: asList(value.video) as MandateProviderAllowlist['video'],
    narration: asList(value.narration) as MandateProviderAllowlist['narration'],
    music: asList(value.music) as MandateProviderAllowlist['music'],
    presenter: asList(value.presenter) as MandateProviderAllowlist['presenter'],
    stock: asList(value.stock) as MandateProviderAllowlist['stock']
  };
}

function toMandateErrorResponse(error: MandateStoreError): NextResponse {
  return NextResponse.json(
    { message: error.message, code: error.code },
    { status: error.status }
  );
}

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    await requireProjectAccess(request, id);
    const mandate = await readProjectMandate(id);
    if (!mandate) {
      return NextResponse.json({ message: 'No production mandate exists for this project.', code: 'MANDATE_NOT_FOUND' }, { status: 404 });
    }
    const status = resolveMandateStatus(mandate);
    const resolved = { ...mandate, status };
    return NextResponse.json({ mandate: publicMandateView(resolved), live: isMandateLive(resolved) });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected mandate read failure.', code: 'mandate.unexpected' }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const { identity } = await requireProjectAccess(request, id);
    if (identity.kind !== 'user') {
      throw new AccessControlError('A browser session is required to issue a production mandate.', 'FORBIDDEN', 403);
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const allowedActions = parseAllowedActions(body.allowedActions);
    if (body.allowedActions !== undefined && allowedActions?.length === 0) {
      return NextResponse.json({ message: 'A production mandate must allow at least one action.', code: 'MANDATE_INVALID' }, { status: 400 });
    }

    const ttlMs = parsePositiveInt(body.ttlMs);
    const mandate = await createProjectMandate({
      projectId: id,
      issuedBy: identity.subject,
      brief: typeof body.brief === 'string' ? body.brief : undefined,
      allowedActions,
      allowedProviders: parseAllowedProviders(body.allowedProviders),
      budgets: parseBudgets(body.budgets),
      ttlMs: ttlMs ? Math.min(MAX_MANDATE_TTL_MS, Math.max(MIN_MANDATE_TTL_MS, ttlMs)) : DEFAULT_MANDATE_TTL_MS,
      maxDurationMs: parsePositiveInt(body.maxDurationMs),
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined
    });
    const resolved = { ...mandate, status: resolveMandateStatus(mandate) };
    return NextResponse.json({ mandate: publicMandateView(resolved), live: isMandateLive(resolved) }, { status: 201 });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    if (error instanceof MandateStoreError) {
      return toMandateErrorResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected mandate creation failure.', code: 'mandate.unexpected' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const { identity } = await requireProjectAccess(request, id);
    if (identity.kind !== 'user') {
      throw new AccessControlError('A browser session is required to revoke a production mandate.', 'FORBIDDEN', 403);
    }
    const mandate = await revokeProjectMandate(id);
    const resolved = { ...mandate, status: resolveMandateStatus(mandate) };
    return NextResponse.json({ mandate: publicMandateView(resolved), live: isMandateLive(resolved) });
  } catch (error) {
    if (error instanceof AccessControlError) {
      return toAccessControlResponse(error);
    }
    if (error instanceof MandateStoreError) {
      return toMandateErrorResponse(error);
    }
    return NextResponse.json({ message: 'Unexpected mandate revocation failure.', code: 'mandate.unexpected' }, { status: 500 });
  }
}
