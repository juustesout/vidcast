import {Renderer, RendererResult} from '@motion-canvas/core';
import type {Project} from '@motion-canvas/core';
import {Vector2} from '@motion-canvas/core';

import type {TemplateParamPayload} from './template-params';

const search = new URLSearchParams(location.search);
const target = search.get('target') ?? 'proof';
const which =
  target === 'alpha' || target === 'overlay' || target === 'chart' ? target : 'proof';

try {
  const response = await fetch('/__params');
  if (response.ok) {
    const payload = (await response.json()) as TemplateParamPayload;
    (globalThis as {__MC_TEMPLATE_PARAMS?: TemplateParamPayload}).__MC_TEMPLATE_PARAMS =
      payload;
  }
} catch {
  (globalThis as {__MC_TEMPLATE_PARAMS?: TemplateParamPayload}).__MC_TEMPLATE_PARAMS = {};
}

const loaded =
  which === 'alpha'
    ? await import('./project-alpha.ts?project')
    : which === 'overlay'
      ? await import('./project-overlay.ts?project')
      : which === 'chart'
        ? await import('./project-chart.ts?project')
        : await import('./project.ts?project');

const project = loaded.default as Project;
const renderer = new Renderer(project);
const base = project.meta.getFullRenderingSettings();
const overlayPng = which === 'overlay';
const payload = (globalThis as {__MC_TEMPLATE_PARAMS?: TemplateParamPayload})
  .__MC_TEMPLATE_PARAMS;
const chartBackground =
  typeof payload?.params?.background === 'string' ? payload.params.background : '#0f172a';
const outputName =
  typeof payload?.outputName === 'string' && payload.outputName.trim()
    ? payload.outputName.trim()
    : which === 'alpha'
      ? 'p102-1-alpha'
      : which === 'overlay'
        ? 'p102-2-overlay'
        : which === 'chart'
          ? 'p102-3-chart'
          : 'p102-1-proof';

const settings = {
  ...base,
  name: outputName,
  fps: overlayPng || which === 'chart' ? 30 : base.fps,
  background: overlayPng ? null : which === 'chart' ? chartBackground : base.background,
  size: overlayPng ? new Vector2(520, 780) : base.size,
  exporter: overlayPng
    ? {
        name: '@motion-canvas/core/image-sequence',
        options: {
          fileType: 'image/png',
          quality: 100,
          groupByScene: false,
        },
      }
    : which === 'chart'
      ? {
          name: '@motion-canvas/ffmpeg',
          options: {
            fastStart: true,
            includeAudio: false,
          },
        }
      : base.exporter,
};

const done = globalThis as {
  __MC_RENDER_DONE?: boolean;
  __MC_RENDER_ERROR?: string | null;
  __MC_RENDER_RESULT?: RendererResult | null;
};

done.__MC_RENDER_DONE = false;
done.__MC_RENDER_ERROR = null;
done.__MC_RENDER_RESULT = null;

const finished = new Promise<RendererResult>(resolve => {
  renderer.onFinished.subscribe(resolve);
});

try {
  await renderer.render(settings);
  done.__MC_RENDER_RESULT = await finished;
  done.__MC_RENDER_DONE = true;
} catch (error) {
  done.__MC_RENDER_ERROR =
    error instanceof Error ? error.message : String(error);
  done.__MC_RENDER_DONE = true;
}
