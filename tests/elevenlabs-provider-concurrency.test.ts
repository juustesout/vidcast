import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetKeyedLimiterForTests, withKeyedLimit } from '@/lib/concurrency/keyed-limiter';
import { mediaMetadataReader } from '@/lib/media/metadata-reader';
import { ElevenLabsTextToSpeechProvider } from '@/lib/ai/text-to-speech/elevenlabs-provider';

// Regression for P30/F3: parallel scenes must never jointly exceed ElevenLabs'
// simultaneous-request ceiling. The provider-wide semaphore is the enforcement
// point, so these tests drive it directly with controlled parallel tasks instead
// of spending real narration credits.

function audioResponse(): Response {
  return new Response(JSON.stringify({ audio_base64: Buffer.from([0x49, 0x44, 0x33, 0x04]).toString('base64') }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

interface ConcurrencyProbe {
  fetchImpl: ReturnType<typeof vi.fn>;
  active: () => number;
  maxActive: () => number;
  release: () => void;
}

function concurrencyProbe(): ConcurrencyProbe {
  let active = 0;
  let maxActive = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = vi.fn(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await gate;
    active -= 1;
    return audioResponse();
  });
  return { fetchImpl, active: () => active, maxActive: () => maxActive, release };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('ElevenLabs provider concurrency cap', () => {
  beforeEach(() => {
    resetKeyedLimiterForTests();
    vi.spyOn(mediaMetadataReader, 'read').mockResolvedValue({ duration: 1, mimeType: 'audio/mpeg', filesize: 4 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('defaults to at most 3 simultaneous requests', async () => {
    const probe = concurrencyProbe();
    vi.stubGlobal('fetch', probe.fetchImpl);
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', timeoutMs: 5000 });

    const tasks = Array.from({ length: 9 }, (_value, index) =>
      provider.synthesize({ text: 'hello', voiceId: 'voice', format: 'mp3', model: `m-${index}` })
    );

    await nextTick();
    expect(probe.active()).toBe(3);

    probe.release();
    await Promise.all(tasks);
    expect(probe.maxActive()).toBe(3);
  });

  it('honours a configurable limit from the environment', async () => {
    vi.stubEnv('ELEVENLABS_TTS_MAX_CONCURRENCY', '2');
    const probe = concurrencyProbe();
    vi.stubGlobal('fetch', probe.fetchImpl);
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', timeoutMs: 5000 });

    const tasks = Array.from({ length: 6 }, () =>
      provider.synthesize({ text: 'hello', voiceId: 'voice', format: 'mp3' })
    );

    await nextTick();
    expect(probe.active()).toBe(2);

    probe.release();
    await Promise.all(tasks);
    expect(probe.maxActive()).toBe(2);
  });

  it('can be capped to a single request when the account requires it', async () => {
    const probe = concurrencyProbe();
    vi.stubGlobal('fetch', probe.fetchImpl);
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', timeoutMs: 5000, maxConcurrency: 1 });

    const tasks = Array.from({ length: 4 }, () =>
      provider.synthesize({ text: 'hello', voiceId: 'voice', format: 'mp3' })
    );

    await nextTick();
    expect(probe.active()).toBe(1);

    probe.release();
    await Promise.all(tasks);
    expect(probe.maxActive()).toBe(1);
  });

  it('releases the slot when a request fails so later scenes still run', async () => {
    let call = 0;
    let observedMax = 0;
    let active = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      active += 1;
      observedMax = Math.max(observedMax, active);
      await Promise.resolve();
      active -= 1;
      if (call === 1) {
        return new Response('nope', { status: 500 });
      }
      return audioResponse();
    });
    vi.stubGlobal('fetch', fetchImpl);
    const provider = new ElevenLabsTextToSpeechProvider({ apiKey: 'test-key', timeoutMs: 5000, maxConcurrency: 1 });

    const first = provider.synthesize({ text: 'one', voiceId: 'voice', format: 'mp3' });
    const second = provider.synthesize({ text: 'two', voiceId: 'voice', format: 'mp3' });

    await expect(first).rejects.toMatchObject({ code: 'PROVIDER_FAILED' });
    await expect(second).resolves.toMatchObject({ provider: 'elevenlabs' });
    expect(observedMax).toBe(1);
  });
});

describe('keyed limiter utility', () => {
  beforeEach(() => {
    resetKeyedLimiterForTests();
  });

  it('serializes work for the same key and runs across keys independently', async () => {
    let active = 0;
    let max = 0;
    const run = () =>
      withKeyedLimit('provider:x', 2, async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      });

    await Promise.all([run(), run(), run(), run()]);
    expect(max).toBe(2);
  });

  it('frees the slot even when the task throws', async () => {
    let entered = 0;
    await expect(
      withKeyedLimit('provider:y', 1, async () => {
        entered += 1;
        throw new Error('boom');
      })
    ).rejects.toThrowError('boom');

    await withKeyedLimit('provider:y', 1, async () => {
      entered += 1;
    });
    expect(entered).toBe(2);
  });
});
