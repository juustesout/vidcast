export async function register(): Promise<void> {
  if (process.env.NEXT_PHASE === 'phase-production-build') {
    return;
  }

  const { assertSecurityConfiguration } = await import('./lib/security/config');
  assertSecurityConfiguration();
}
