import { describe, expect, it } from 'vitest';

import { publicErrorMessage, publicMessageForProviderCode, shouldSanitizeProviderCode } from '@/lib/security/safe-error';

describe('safe provider errors', () => {
  it('maps provider codes to bounded public messages', () => {
    expect(publicMessageForProviderCode('PROVIDER_AUTH')).toBe('Provider authentication failed.');
    expect(publicMessageForProviderCode('PROVIDER_RATE_LIMIT')).toBe('Provider rate limit exceeded.');
    expect(publicMessageForProviderCode('PROVIDER_REJECTED')).toBe('Provider rejected the request.');
    expect(publicMessageForProviderCode('PROVIDER_FAILED')).toBe('Provider request failed.');
  });

  it('does not echo raw provider bodies on sanitizable codes', () => {
    expect(shouldSanitizeProviderCode('PROVIDER_FAILED')).toBe(true);
    expect(
      publicErrorMessage(
        { code: 'PROVIDER_FAILED', message: 'Authorization: Bearer sk-secret; detail: quota exceeded' },
        'fallback'
      )
    ).toBe('Provider request failed.');
  });

  it('keeps local configuration messages for non-provider codes', () => {
    expect(shouldSanitizeProviderCode('NOT_CONFIGURED')).toBe(false);
    expect(
      publicErrorMessage(
        Object.assign(new Error('HeyGen requires HEYGEN_API_KEY.'), { code: 'NOT_CONFIGURED' }),
        'fallback'
      )
    ).toBe('HeyGen requires HEYGEN_API_KEY.');
  });
});
