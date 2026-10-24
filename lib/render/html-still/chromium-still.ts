import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ProcessExecutionError, runProcess } from '@/lib/render/ffmpeg-executor';
import { findChromiumPath } from '@/lib/render/chromium';
import { HtmlStillError } from './errors';
import { injectTrustedHtmlStillImages, type ResolvedHtmlStillImage } from './image-assets';
import { wrapHtmlStillDocument } from './sanitize';

export const DEFAULT_HTML_STILL_TIMEOUT_MS = 15_000;
export const MIN_HTML_STILL_TIMEOUT_MS = 1_000;
export const MAX_HTML_STILL_TIMEOUT_MS = 60_000;
export const HTML_STILL_MIN_BYTES = 200;

export interface HtmlStillRenderInput {
  markup: string;
  css?: string;
  width: number;
  height: number;
  background: 'opaque' | 'transparent';
  pageBackground?: string;
  timeoutMs?: number;
  images?: readonly ResolvedHtmlStillImage[];
}

export interface HtmlStillRenderResult {
  png: Buffer;
  width: number;
  height: number;
  background: 'opaque' | 'transparent';
}

function resolveTimeoutMs(value: number | undefined): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_HTML_STILL_TIMEOUT_MS;
  return Math.min(MAX_HTML_STILL_TIMEOUT_MS, Math.max(MIN_HTML_STILL_TIMEOUT_MS, parsed));
}

function assertViewport(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 3840 || height > 2160) {
    throw new HtmlStillError('html.invalid', 'HTML still size must be an integer between 64 and 3840x2160.');
  }
}

async function assertCompletePng(filePath: string): Promise<Buffer> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw new HtmlStillError('html.output.incomplete', 'Chromium still PNG is missing.');
  }
  if (!stat.isFile() || stat.size < HTML_STILL_MIN_BYTES) {
    throw new HtmlStillError('html.output.incomplete', 'Chromium still PNG is incomplete.', 500, { size: stat.size });
  }
  const bytes = await fs.readFile(filePath);
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new HtmlStillError('html.output.invalid', 'Chromium still output is not a PNG.');
  }
  return bytes;
}

export async function renderHtmlStillPng(input: HtmlStillRenderInput): Promise<HtmlStillRenderResult> {
  assertViewport(input.width, input.height);
  const chromium = await findChromiumPath();
  if (!chromium) {
    throw new HtmlStillError('html.chromium.missing', 'No Chromium/Chrome binary found for HTML still render.', 503);
  }

  const document = injectTrustedHtmlStillImages(wrapHtmlStillDocument({
    markup: input.markup,
    css: input.css,
    width: input.width,
    height: input.height,
    background: input.background,
    pageBackground: input.pageBackground
  }), input.images ?? []);

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-still-'));
  const htmlPath = path.join(workDir, 'still.html');
  const pngPath = path.join(workDir, 'still.png');
  const profileDir = path.join(workDir, 'chrome-profile');
  const timeoutMs = resolveTimeoutMs(input.timeoutMs);

  try {
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(htmlPath, document, 'utf8');
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-crash-reporter',
      `--user-data-dir=${profileDir}`,
      `--window-size=${input.width},${input.height}`,
      `--screenshot=${pngPath}`,
      '--default-background-color=00000000',
      `file://${htmlPath}`
    ];

    try {
      await runProcess(chromium, args, { timeoutMs: timeoutMs + 2_000, cwd: workDir });
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        if (error.reason === 'spawn_error') {
          throw new HtmlStillError('html.chromium.missing', 'Chromium could not be started for HTML still render.', 503);
        }
        if (error.reason === 'timeout') {
          throw new HtmlStillError('html.render.timeout', `HTML still render timed out after ${timeoutMs}ms.`, 504);
        }
        throw new HtmlStillError('html.render.failed', 'Chromium failed while rendering HTML still.', 500, {
          stderr: error.stderr.slice(-4_000)
        });
      }
      throw error;
    }

    const png = await assertCompletePng(pngPath);
    return {
      png,
      width: input.width,
      height: input.height,
      background: input.background
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
