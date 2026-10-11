/**
 * Opt-in, fail-closed smoke runner for the real OpenAI image pilot.
 *
 * It performs exactly ONE paid OpenAI Images request for ONE generated-image
 * scene, persists the returned PNG through the real media store, renders that
 * scene with local FFmpeg and composes the final project video.
 *
 * This script is NOT executed automatically and is NOT part of `npm test`. It
 * only runs when every gate below is satisfied, otherwise it exits non-zero
 * without touching any provider.
 *
 * Required environment (see lib/ai/image-generation/real-image-pilot.ts):
 * - RUN_REAL_IMAGE_PILOT=true
 * - CONFIRM_REAL_IMAGE_PILOT=YES
 * - OPENAI_API_KEY=<present>
 *
 * Usage:
 *   npx tsx scripts/real-image-pilot.ts <projectId> <sceneId>
 *
 * The scene must be a `generated_image` scene; its current image is regenerated
 * so an existing asset is not treated as the pilot result.
 */
import { resolveRealImagePilotGate } from '@/lib/ai/image-generation/real-image-pilot';
import { generateSceneImage } from '@/lib/generation/image-generation-service';
import { sceneRenderService } from '@/lib/render/scene-render-service';
import { videoCompositionService } from '@/lib/render/video-composition-service';
import { projectStore } from '@/lib/storage/project-store';

function fail(message: string): never {
  console.error(`[real-image-pilot] ${message}`);
  process.exit(1);
}

function countImageRequests(): () => number {
  let count = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/images/')) {
      count += 1;
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  return () => count;
}

async function main(): Promise<void> {
  const gate = resolveRealImagePilotGate();
  if (!gate.allowed) {
    fail(
      `${gate.reason ?? 'Real image pilot is not enabled.'} ` +
        'Set RUN_REAL_IMAGE_PILOT=true, CONFIRM_REAL_IMAGE_PILOT=YES and OPENAI_API_KEY, then retry.'
    );
  }

  const [projectId, sceneId] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  if (!projectId || !sceneId) {
    fail('Usage: npx tsx scripts/real-image-pilot.ts <projectId> <sceneId>');
  }

  const project = await projectStore.getProject(projectId);
  if (!project) {
    fail(`Project ${projectId} not found.`);
  }

  const scene = project.scenes.find((entry) => entry.id === sceneId);
  if (!scene) {
    fail(`Scene ${sceneId} not found in project ${projectId}.`);
  }
  if (!scene.visual || scene.visual.kind !== 'generated_image') {
    fail(`Scene ${sceneId} is not a generated_image scene.`);
  }

  const requestCount = countImageRequests();

  console.log(`[real-image-pilot] Generating one real image for ${projectId}/${sceneId} ...`);
  const generation = await generateSceneImage(projectId, sceneId, { regenerate: true });
  const issued = requestCount();
  if (issued !== 1) {
    fail(`Expected exactly one paid image request, observed ${issued}.`);
  }

  console.log(`[real-image-pilot] Asset written: ${generation.assetId} (provider=${generation.provider}).`);

  console.log('[real-image-pilot] Rendering scene ...');
  const rendered = await sceneRenderService.renderScene(projectId, sceneId);
  console.log(`[real-image-pilot] Scene render: ${rendered.render.outputPath} (${rendered.render.status}).`);
  if (rendered.render.status !== 'completed') {
    fail(`Scene render did not complete: ${rendered.render.message ?? 'unknown error'}.`);
  }

  console.log('[real-image-pilot] Composing final video ...');
  const composition = await videoCompositionService.composeProject(projectId);
  console.log(`[real-image-pilot] Final composition: ${composition.artifact.outputPath}.`);
  console.log('[real-image-pilot] PASS');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`Unexpected failure: ${message}`);
});
