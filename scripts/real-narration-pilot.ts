/**
 * Opt-in, fail-closed smoke runner for the real ElevenLabs narration pilot.
 *
 * It performs exactly ONE paid ElevenLabs text-to-speech request for ONE scene
 * through the real narration service, persists the returned audio via the real
 * media store, renders that scene with local FFmpeg, composes the final project
 * video and verifies the composed MP4 actually carries non-silent audio.
 *
 * This script is NOT executed automatically and is NOT part of `npm test`. It
 * only runs when every gate below is satisfied, otherwise it exits non-zero
 * without touching any provider. There is no retry: any failure stops the run.
 *
 * Required environment (see lib/ai/text-to-speech/real-narration-pilot.ts):
 * - RUN_REAL_NARRATION_PILOT=true
 * - CONFIRM_REAL_NARRATION_PILOT=YES
 * - ELEVENLABS_API_KEY=<present>
 *
 * Usage:
 *   npx tsx scripts/real-narration-pilot.ts <projectId> <sceneId> [--voice <id>] [--text "<line>"]
 *
 * The scene must already have narration text (or one must be supplied with
 * `--text`). Its narration is regenerated so an existing asset is never
 * mistaken for the pilot result.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { resolveRealImagePilotGate } from '@/lib/ai/image-generation/real-image-pilot';
import { resolveRealNarrationPilotGate } from '@/lib/ai/text-to-speech/real-narration-pilot';
import { generateSceneNarration } from '@/lib/generation/narration-service';
import { resolveRunPolicyServerConfig } from '@/lib/production/run-policy';
import { sceneRenderService } from '@/lib/render/scene-render-service';
import { videoCompositionService } from '@/lib/render/video-composition-service';
import { getProjectRoot } from '@/lib/storage/storage-paths';
import { projectStore } from '@/lib/storage/project-store';

function fail(message: string): never {
  console.error(`[real-narration-pilot] ${message}`);
  process.exit(1);
}

function assertToolAvailable(tool: string): void {
  const probe = spawnSync(tool, ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    fail(`Required tool "${tool}" is not available on PATH.`);
  }
}

function countNarrationRequests(): () => number {
  let count = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/text-to-speech/')) {
      count += 1;
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  return () => count;
}

interface AudioProbe {
  hasAudioStream: boolean;
  codec?: string;
  durationSeconds?: number;
  maxVolumeDb?: number;
  meanVolumeDb?: number;
}

function probeComposedAudio(filePath: string): AudioProbe {
  const streamProbe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,duration', '-show_entries', 'format=duration', '-of', 'json', filePath],
    { encoding: 'utf8' }
  );
  if (streamProbe.status !== 0) {
    fail(`ffprobe failed on ${filePath}: ${streamProbe.stderr?.trim() || 'unknown error'}`);
  }

  const parsed = JSON.parse(streamProbe.stdout || '{}') as {
    streams?: Array<{ codec_name?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const audioStream = parsed.streams?.[0];

  const volumeProbe = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', filePath, '-af', 'volumedetect', '-f', 'null', '-'], {
    encoding: 'utf8'
  });
  const volumeOutput = `${volumeProbe.stdout ?? ''}\n${volumeProbe.stderr ?? ''}`;
  const maxMatch = volumeOutput.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/);
  const meanMatch = volumeOutput.match(/mean_volume:\s*(-?[\d.]+|-inf)\s*dB/);

  return {
    hasAudioStream: Boolean(audioStream),
    codec: audioStream?.codec_name,
    durationSeconds: Number(audioStream?.duration ?? parsed.format?.duration),
    maxVolumeDb: maxMatch ? (maxMatch[1] === '-inf' ? -Infinity : Number(maxMatch[1])) : undefined,
    meanVolumeDb: meanMatch ? (meanMatch[1] === '-inf' ? -Infinity : Number(meanMatch[1])) : undefined
  };
}

async function main(): Promise<void> {
  const gate = resolveRealNarrationPilotGate();
  if (!gate.allowed) {
    fail(
      `${gate.reason ?? 'Real narration pilot is not enabled.'} ` +
        'Set RUN_REAL_NARRATION_PILOT=true, CONFIRM_REAL_NARRATION_PILOT=YES and ELEVENLABS_API_KEY, then retry.'
    );
  }

  const argv = process.argv.slice(2);
  const positionals: string[] = [];
  let voiceId: string | undefined;
  let text: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--voice') {
      voiceId = argv[++i];
      continue;
    }
    if (arg === '--text') {
      text = argv[++i];
      continue;
    }
    if (arg.startsWith('--')) {
      continue;
    }
    positionals.push(arg);
  }

  const [projectId, sceneId] = positionals;
  if (!projectId || !sceneId) {
    fail('Usage: npx tsx scripts/real-narration-pilot.ts <projectId> <sceneId> [--voice <id>] [--text "<line>"]');
  }

  // Preflight: no paid request is made here.
  // Guard: only the narration pilot may be active. Image pilot and global
  // real-provider mode must stay off so this run cannot touch any other
  // modality.
  if (resolveRunPolicyServerConfig().allowRealProviders) {
    fail('PRODUCTION_RUN_ALLOW_REAL_PROVIDERS must be off for the narration pilot.');
  }
  if (resolveRealImagePilotGate().allowed) {
    fail('The real image pilot must be disabled during the narration pilot.');
  }
  assertToolAvailable('ffmpeg');
  assertToolAvailable('ffprobe');

  const project = await projectStore.getProject(projectId);
  if (!project) {
    fail(`Project ${projectId} not found.`);
  }

  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    fail(`Scene ${sceneId} not found in project ${projectId}.`);
  }
  if (!voiceId && !scene.narration?.voiceId?.trim()) {
    fail(`Pass --voice <id> or set the scene narration voice; ElevenLabs has no usable default voice id.`);
  }
  if (!text?.trim() && !scene.narration?.text?.trim()) {
    fail(`Scene ${sceneId} has no narration text to synthesize. Pass --text "<line>".`);
  }

  const requestCount = countNarrationRequests();

  console.log(`[real-narration-pilot] Synthesizing one real narration for ${projectId}/${sceneId} ...`);
  const generation = await generateSceneNarration(projectId, sceneId, { regenerate: true, voiceId, text });
  const issued = requestCount();
  if (issued !== 1) {
    fail(`Expected exactly one paid narration request, observed ${issued}.`);
  }

  console.log(`[real-narration-pilot] Audio asset written: ${generation.assetId} (provider=${generation.provider}, format=${generation.format}, duration=${generation.duration ?? 'n/a'}s).`);

  console.log('[real-narration-pilot] Rendering scene ...');
  const rendered = await sceneRenderService.renderScene(projectId, sceneId);
  console.log(`[real-narration-pilot] Scene render: ${rendered.render.outputPath} (${rendered.render.status}).`);
  if (rendered.render.status !== 'completed') {
    fail(`Scene render did not complete: ${rendered.render.message ?? 'unknown error'}.`);
  }

  console.log('[real-narration-pilot] Composing final video ...');
  const composition = await videoCompositionService.composeProject(projectId);
  const absoluteOutput = path.join(getProjectRoot(projectId), composition.artifact.outputPath);
  console.log(`[real-narration-pilot] Final composition: ${composition.artifact.outputPath}.`);

  const probe = probeComposedAudio(absoluteOutput);
  if (!probe.hasAudioStream) {
    fail('Composed MP4 has no audio stream.');
  }
  if (!(typeof probe.durationSeconds === 'number' && probe.durationSeconds > 0)) {
    fail(`Composed MP4 audio stream has no positive duration (got ${probe.durationSeconds}).`);
  }
  if (!(typeof probe.maxVolumeDb === 'number' && probe.maxVolumeDb > -60)) {
    fail(`Composed MP4 audio appears silent (max_volume=${probe.maxVolumeDb ?? 'n/a'} dB).`);
  }

  console.log(`[real-narration-pilot] Composed audio: codec=${probe.codec}, duration=${probe.durationSeconds?.toFixed(3)}s, max_volume=${probe.maxVolumeDb} dB, mean_volume=${probe.meanVolumeDb ?? 'n/a'} dB.`);
  console.log('[real-narration-pilot] PASS');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Unexpected failure: ${message}`);
});
