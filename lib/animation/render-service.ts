import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { createFFmpegRuntime } from '@/lib/render/ffmpeg-runtime';
import { runFfmpeg, runProcess } from '@/lib/render/ffmpeg-executor';
import { mediaStore } from '@/lib/storage/media-store';
import { projectStore } from '@/lib/storage/project-store';
import { getWorkspaceRoot } from '@/lib/storage/storage-paths';
import { createId } from '@/lib/utils/ids';
import { getAnimationTemplate } from './catalog';
import { AnimationError } from './errors';
import type { AnimationTemplateDefinition, AnimationTemplateParams, AnimationRenderResult } from './types';
import { validateAnimationRenderInput } from './validate';

const MOTION_CANVAS_ROOT = path.join(getWorkspaceRoot(), 'motion-canvas');
const MOTION_CANVAS_OUTPUT = path.join(MOTION_CANVAS_ROOT, 'output');
const PARAMS_FILE = path.join(MOTION_CANVAS_OUTPUT, 'p102-4-params.json');
const DEFAULT_MC_PORT = 9000;
const RENDER_TIMEOUT_MS = 180_000;
const CHROMIUM_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/lib/chromium/chromium'
];

const runtime = createFFmpegRuntime();

function nowIso(): string {
  return new Date().toISOString();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findChromium(): Promise<string> {
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (candidate && await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new AnimationError('animation.chromium.missing', 'No Chromium/Chrome binary found for Motion Canvas render.');
}

async function ensureFfmpeg(): Promise<void> {
  try {
    await runProcess(runtime.ffmpegPath, ['-version'], { timeoutMs: 10_000 });
  } catch {
    throw new AnimationError('animation.ffmpeg.unavailable', 'FFmpeg is not available on this host.');
  }
}

async function writeParamsFile(template: AnimationTemplateDefinition, params: AnimationTemplateParams): Promise<void> {
  await fs.mkdir(MOTION_CANVAS_OUTPUT, { recursive: true });
  const payload = {
    templateId: template.id,
    target: template.headlessTarget,
    outputName: template.id === 'northwind_arr_chart' ? 'p102-4-chart' : 'p102-4-overlay',
    generatedAt: nowIso(),
    params
  };
  await fs.writeFile(PARAMS_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // missing is fine
  }
}

async function emptyDir(dirPath: string): Promise<void> {
  try {
    const entries = await fs.readdir(dirPath);
    await Promise.all(entries.map((name) => fs.unlink(path.join(dirPath, name)).catch(() => undefined)));
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

function appendCapped(current: string, chunk: Buffer, maxChars = 32_000): string {
  const next = current + chunk.toString('utf8');
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    setTimeout(() => {
      if (child.exitCode !== null) {
        return;
      }
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 500);
    return;
  }
  child.kill('SIGTERM');
}

function waitForExit(child: ChildProcess, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killProcessGroup(child);
      reject(new AnimationError('animation.render.timeout', `${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(new AnimationError('animation.render.failed', error.message));
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new AnimationError('animation.render.failed', `${label} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}.`));
    });
  });
}

async function runHeadless(template: AnimationTemplateDefinition): Promise<void> {
  await findChromium();
  const port = Number(process.env.MC_PORT ?? DEFAULT_MC_PORT);
  const child = spawn('node', ['scripts/headless-render.mjs', template.headlessTarget], {
    cwd: MOTION_CANVAS_ROOT,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MC_PORT: String(port),
      MC_RENDER_TIMEOUT_MS: String(RENDER_TIMEOUT_MS),
      MC_PARAMS_FILE: PARAMS_FILE,
      BROWSER: 'none'
    }
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout = appendCapped(stdout, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = appendCapped(stderr, chunk);
  });

  try {
    await waitForExit(child, RENDER_TIMEOUT_MS + 15_000, 'Motion Canvas headless render');
  } catch (error) {
    if (error instanceof AnimationError) {
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' ');
      throw new AnimationError(error.code, detail ? `${error.message} ${detail}` : error.message);
    }
    throw error;
  }
}

async function collectPngSequence(dirPath: string): Promise<string[]> {
  const names = (await fs.readdir(dirPath))
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort();
  if (names.length < 10) {
    throw new AnimationError('animation.output.incomplete', 'Overlay PNG sequence is incomplete.', {
      dirPath,
      frames: names.length
    });
  }
  return names;
}

async function muxOverlayWebm(pngDir: string, webmPath: string, fps: number): Promise<void> {
  await ensureFfmpeg();
  await collectPngSequence(pngDir);
  await runFfmpeg(runtime.ffmpegPath, [
    '-y',
    '-framerate',
    String(fps),
    '-i',
    path.join(pngDir, '%06d.png'),
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-an',
    webmPath
  ], { timeoutMs: 180_000 }, 'scene_render');
}

async function assertCompleteFile(filePath: string, minBytes: number): Promise<Buffer> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new AnimationError('animation.output.incomplete', 'Rendered animation file is missing.', { filePath });
  }
  if (!stat.isFile() || stat.size < minBytes) {
    throw new AnimationError('animation.output.incomplete', 'Rendered animation file is incomplete.', {
      filePath,
      size: stat.size
    });
  }
  return fs.readFile(filePath);
}

function mimeFile(bytes: Buffer, fileName: string, mimeType: string): File {
  return new File([new Uint8Array(bytes)], fileName, { type: mimeType });
}

export async function renderAnimationTemplate(raw: unknown): Promise<AnimationRenderResult> {
  const input = validateAnimationRenderInput(raw);
  const project = await projectStore.getProject(input.projectId);
  if (!project) {
    throw new AnimationError('animation.project.notFound', 'Project not found.', { projectId: input.projectId });
  }

  const template = getAnimationTemplate(input.templateId);
  if (!template) {
    throw new AnimationError('animation.template.notFound', `Unknown animation template: ${input.templateId}.`);
  }

  const chartMp4 = path.join(MOTION_CANVAS_OUTPUT, 'p102-4-chart.mp4');
  const overlayDir = path.join(MOTION_CANVAS_OUTPUT, 'p102-4-overlay');
  const overlayWebm = path.join(MOTION_CANVAS_OUTPUT, 'p102-4-overlay.webm');

  await fs.mkdir(MOTION_CANVAS_OUTPUT, { recursive: true });
  await writeParamsFile(template, input.params);

  let producedPath: string;
  let mimeType: string;
  let suggestedName: string;

  try {
    if (template.id === 'northwind_arr_chart') {
      await removeIfExists(chartMp4);
      await runHeadless(template);
      producedPath = chartMp4;
      mimeType = 'video/mp4';
      suggestedName = `mc-northwind-arr-chart.mp4`;
    } else {
      await fs.mkdir(overlayDir, { recursive: true });
      await emptyDir(overlayDir);
      await removeIfExists(overlayWebm);
      await runHeadless(template);
      await muxOverlayWebm(overlayDir, overlayWebm, template.output.fps);
      producedPath = overlayWebm;
      mimeType = 'video/webm';
      suggestedName = `mc-nix-overlay.webm`;
    }

    const bytes = await assertCompleteFile(producedPath, 1024);
    const { asset } = await mediaStore.saveAsset(
      input.projectId,
      mimeFile(bytes, suggestedName, mimeType)
    );
    const persisted = await projectStore.mutateProject(input.projectId, (current) => ({
      ...current,
      assets: [...current.assets, {
        ...asset,
        provenance: 'generated',
        generation: {
          generationId: createId('animation'),
          provider: 'motion-canvas',
          model: template.id,
          prompt: template.title,
          referenceIds: []
        },
        metadata: {
          ...asset.metadata,
          animationTemplateId: template.id,
          animationDestination: template.destination
        }
      }]
    }));

    if (!persisted) {
      throw new AnimationError('animation.project.notFound', 'Project not found.', { projectId: input.projectId });
    }

    const stored = persisted.assets.find((entry) => entry.id === asset.id);
    if (!stored?.localPath) {
      throw new AnimationError('animation.output.incomplete', 'Rendered animation was not stored as a project asset.');
    }

    return {
      projectId: input.projectId,
      templateId: template.id,
      assetId: stored.id,
      localPath: stored.localPath,
      mimeType: stored.mimeType || mimeType,
      destination: template.destination,
      width: stored.width,
      height: stored.height,
      duration: stored.duration,
      filesize: stored.filesize
    };
  } finally {
    await removeIfExists(PARAMS_FILE);
    if (template.id === 'northwind_arr_chart') {
      await removeIfExists(chartMp4);
    } else {
      await emptyDir(overlayDir);
      await removeIfExists(overlayWebm);
    }
  }
}
