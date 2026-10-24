const PROVIDER_BODY_CODES = new Set([
  'PROVIDER_AUTH',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_REJECTED',
  'PROVIDER_FAILED',
  'PROVIDER_ERROR',
  'provider.request.unauthorized',
  'provider.request.rateLimited',
  'provider.request.rejected',
  'provider.request.failed',
  'provider.request.timeout',
  'provider.request.unreachable'
]);

const LOG_BODY_LIMIT = 500;

export function shouldSanitizeProviderCode(code: string | undefined): boolean {
  return Boolean(code && PROVIDER_BODY_CODES.has(code));
}

export function publicMessageForProviderCode(code: string): string {
  switch (code) {
    case 'PROVIDER_AUTH':
    case 'provider.request.unauthorized':
      return 'Provider authentication failed.';
    case 'PROVIDER_RATE_LIMIT':
    case 'provider.request.rateLimited':
      return 'Provider rate limit exceeded.';
    case 'PROVIDER_REJECTED':
    case 'provider.request.rejected':
      return 'Provider rejected the request.';
    case 'provider.request.timeout':
      return 'Provider request timed out.';
    case 'provider.request.unreachable':
      return 'Provider was unreachable.';
    default:
      return 'Provider request failed.';
  }
}

export function publicErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (shouldSanitizeProviderCode(code)) {
      return publicMessageForProviderCode(code);
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
  }

  return fallback;
}

function truncateForLog(value: unknown): string | undefined {
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? '';
    } catch {
      return undefined;
    }
  }

  if (!text) {
    return undefined;
  }

  return text.length > LOG_BODY_LIMIT ? text.slice(0, LOG_BODY_LIMIT) : text;
}

export function logProviderError(
  source: string,
  details: {
    code?: string;
    status?: number;
    body?: unknown;
    error?: unknown;
  }
): void {
  const errorText = details.error instanceof Error ? details.error.message : details.error;
  console.error(`[${source}] provider error`, {
    code: details.code,
    status: details.status,
    body: truncateForLog(details.body),
    error: errorText === undefined ? undefined : truncateForLog(errorText)
  });
}
