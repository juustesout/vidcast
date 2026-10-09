'use client';

import Image from 'next/image';
import React, { type ReactNode } from 'react';

import { deriveSceneRenderStatus, formatRenderStatusLabel } from '@/lib/render/render-status';
import type { Project, RenderPlan } from '@/lib/types/render';
import type { Scene } from '@/lib/types/scene';
import { joinProjectAssetUrl, joinProjectFileUrl } from '@/lib/utils/project-files';

interface ScenePreviewProps {
  project: Project;
  scene: Scene;
  renderPlan: RenderPlan;
  isRendering?: boolean;
}

function getSceneAssetId(scene: Scene): string | undefined {
  if (!scene.visual) return undefined;
  if (scene.visual.kind === 'asset') return scene.visual.assetId;
  if (scene.visual.kind === 'generated_image' || scene.visual.kind === 'generated_video') {
    return scene.visual.assetId ?? scene.visual.generation.assetId;
  }
  return undefined;
}

function getMotionClass(scene: Scene): string {
  switch (scene.render.motion.preset) {
    case 'zoom_in':
    case 'zoom_right':
      return 'animate-slowZoomIn';
    case 'zoom_out':
    case 'zoom_left':
      return 'animate-slowZoomOut';
    case 'pan_left':
      return 'animate-slowPanLeft';
    case 'pan_right':
      return 'animate-slowPanRight';
    case 'pan_up':
      return 'animate-slowPanUp';
    case 'pan_down':
      return 'animate-slowPanDown';
    default:
      return '';
  }
}

function previewPlaceholder(scene: Scene): string {
  const visual = scene.visual;
  if (!visual) return 'No visual asset yet';

  if (visual.kind === 'generated_image') {
    return `AI IMAGE\nGeneration ${visual.generation.status}\n${visual.generation.provider ?? 'provider not set'}\n${visual.generation.prompt || 'No prompt yet'}`;
  }

  if (visual.kind === 'generated_video') {
    return `AI VIDEO\nGeneration ${visual.generation.status}\n${visual.generation.provider ?? 'provider not set'}\n${visual.generation.prompt || 'No prompt yet'}`;
  }

  if (visual.kind === 'text') {
    return visual.text;
  }

  if (visual.kind === 'graphic') {
    return `GRAPHIC\n${visual.template ?? 'template pending'}`;
  }

  return 'No visual asset yet';
}

function renderMainPreview(mediaUrl: string | undefined, assetType: string | undefined, scene: Scene, motionClass: string, placeholder: string): ReactNode {
  if (mediaUrl && (assetType === 'image' || assetType === 'graphic')) {
    return React.createElement(Image, {
      src: mediaUrl,
      alt: scene.overlay?.text || scene.narration?.text || 'Scene preview',
      fill: true,
      unoptimized: true,
      sizes: '(max-width: 1280px) 100vw, 70vw',
      className: `object-cover ${motionClass}`
    });
  }

  if (mediaUrl && assetType === 'video') {
    return React.createElement('video', {
      src: mediaUrl,
      controls: true,
      className: 'h-full w-full object-cover'
    });
  }

  return React.createElement(
    'div',
    {
      className:
        'flex h-full w-full items-center justify-center whitespace-pre-line bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 p-6 text-center text-slate-300'
    },
    placeholder
  );
}

export function ScenePreview({ project, scene, renderPlan, isRendering = false }: ScenePreviewProps) {
  const resolvedScene = renderPlan.scenes.find((entry) => entry.sceneId === scene.id);
  const assetId = getSceneAssetId(scene);
  const asset = project.assets.find((entry) => entry.id === assetId);
  const mediaUrl = asset?.localPath ? joinProjectFileUrl(project.id, asset.localPath) : undefined;
  const motionClass = getMotionClass(scene);
  const placeholder = previewPlaceholder(scene);

  const renderStatus = deriveSceneRenderStatus(project, scene, renderPlan, { isRendering });
  const renderedScene = renderStatus.latestCompletedRender;
  const renderedUrl = renderedScene ? `/api/projects/${project.id}/renders/${renderedScene.renderId}/file` : undefined;

  const narrationAudioAsset = scene.narration?.audioAssetId ? project.assets.find((entry) => entry.id === scene.narration?.audioAssetId) : undefined;
  const narrationAudioUrl = narrationAudioAsset ? joinProjectAssetUrl(project.id, narrationAudioAsset.id) : undefined;

  const fallbackProblems = [{ severity: 'info', message: 'Scene is ready to render.' }];
  const readinessProblems = renderStatus.problems.length > 0 ? renderStatus.problems : fallbackProblems;

  const header = React.createElement(
    'div',
    { className: 'flex flex-col gap-3 border-b border-slate-700/70 pb-4 lg:flex-row lg:items-center lg:justify-between' },
    React.createElement(
      'div',
      null,
      React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500' }, 'Preview'),
      React.createElement('h2', { className: 'mt-2 text-2xl font-semibold text-white' }, `Scene ${String(scene.order).padStart(2, '0')}`)
    ),
    React.createElement(
      'div',
      { className: 'flex flex-wrap gap-2 text-xs text-slate-300' },
      React.createElement(Chip, null, scene.type),
      React.createElement(Chip, null, scene.render.motion.preset),
      React.createElement(Chip, null, scene.render.transition.type),
      React.createElement(Chip, null, `${scene.duration.toFixed(1)} sec`),
      React.createElement(Chip, null, resolvedScene?.status ?? 'unknown'),
      React.createElement(Chip, null, formatRenderStatusLabel(renderStatus.status))
    )
  );

  const previewVideo = React.createElement(
    'div',
    { className: 'relative aspect-video overflow-hidden rounded-[24px] border border-slate-700/70 bg-slate-900' },
    renderMainPreview(mediaUrl, asset?.type, scene, motionClass, placeholder),
    React.createElement('div', { className: 'pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/12 to-transparent' }),
    React.createElement(
      'div',
      { className: 'pointer-events-none absolute inset-x-0 bottom-0 p-5' },
      React.createElement(
        'div',
        { className: 'max-w-xl space-y-2' },
        React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.35em] text-slate-200/80' }, 'Browser preview only'),
        scene.overlay?.text ? React.createElement('p', { className: 'text-2xl font-semibold text-white' }, scene.overlay.text) : null,
        scene.narration?.text ? React.createElement('p', { className: 'max-w-2xl text-sm leading-6 text-slate-100/90' }, scene.narration.text) : null
      )
    )
  );

  const narrationPanel = narrationAudioUrl
    ? React.createElement(
        'div',
        { className: 'rounded-2xl border border-slate-700/70 bg-slate-950/35 p-3' },
        React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500' }, 'Narration audio'),
        React.createElement('audio', { controls: true, className: 'mt-2 w-full', src: narrationAudioUrl })
      )
    : null;

  const renderedBody = renderedUrl && renderStatus.status !== 'stale'
    ? React.createElement('video', { controls: true, className: 'mt-3 w-full rounded-xl border border-slate-700/70', src: renderedUrl })
    : renderedUrl
      ? React.createElement(
          'div',
          { className: 'mt-3 rounded-xl border border-amber-300/30 bg-amber-200/10 p-4 text-sm text-amber-100' },
          'A previous render exists, but it is stale because the scene changed afterward.'
        )
      : React.createElement(
          'div',
          { className: 'mt-3 rounded-xl border border-slate-700/70 bg-slate-950/30 p-4 text-sm text-slate-300' },
          'No rendered MP4 available yet.'
        );

  const renderedStats = renderedScene
    ? React.createElement(
        'div',
        { className: 'mt-3 grid gap-3 md:grid-cols-4' },
        React.createElement(InfoCard, { label: 'Render ID', value: renderedScene.renderId }),
        React.createElement(InfoCard, { label: 'Duration', value: `${renderedScene.duration.toFixed(1)} sec` }),
        React.createElement(InfoCard, { label: 'FPS', value: String(renderedScene.fps) }),
        React.createElement(InfoCard, {
          label: 'File size',
          value: renderedScene.filesize > 0 ? `${(renderedScene.filesize / 1024).toFixed(1)} KB` : 'Unknown'
        })
      )
    : null;

  const readinessItems = readinessProblems.map((problem, index) => {
    const colorClass =
      problem.severity === 'blocking'
        ? 'border-rose-400/30 bg-rose-500/10 text-rose-100'
        : problem.severity === 'warning'
          ? 'border-amber-300/30 bg-amber-200/10 text-amber-100'
          : 'border-slate-700/70 bg-slate-950/30 text-slate-200';

    return React.createElement(
      'div',
      { key: `${problem.message}-${index}`, className: `rounded-xl border px-3 py-2 ${colorClass}` },
      problem.message
    );
  });

  return React.createElement(
    'div',
    { className: 'flex h-full flex-col gap-4' },
    header,
    React.createElement(
      'div',
      { className: 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]' },
      React.createElement(
        'div',
        { className: 'space-y-4 rounded-[28px] border border-slate-700/70 bg-slate-950/55 p-4' },
        React.createElement(
          'div',
          null,
          React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500' }, 'Preview'),
          React.createElement('p', { className: 'mt-1 text-sm text-slate-300' }, 'Interactive browser preview of the current scene setup. This is not the final rendered MP4.')
        ),
        previewVideo,
        narrationPanel,
        React.createElement(
          'div',
          { className: 'mt-4 grid gap-3 md:grid-cols-3' },
          React.createElement(InfoCard, { label: 'Visual kind', value: scene.visual?.kind ?? 'none' }),
          React.createElement(InfoCard, {
            label: 'Render plan',
            value: resolvedScene ? `${resolvedScene.source.kind} / ${resolvedScene.motion.preset}` : 'Missing'
          }),
          React.createElement(InfoCard, {
            label: 'Template',
            value: scene.visual && scene.visual.kind === 'graphic' ? scene.visual.template ?? 'None' : 'n/a'
          })
        ),
        React.createElement(
          'div',
          { className: 'rounded-2xl border border-slate-700/70 bg-slate-950/35 p-4' },
          React.createElement(
            'div',
            { className: 'flex items-center justify-between gap-4' },
            React.createElement(
              'div',
              null,
              React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500' }, 'Rendered'),
              React.createElement('p', { className: 'mt-1 text-sm text-slate-300' }, 'Definitive scene MP4 produced by the P5 renderer.')
            ),
            React.createElement(Chip, null, formatRenderStatusLabel(renderStatus.status))
          ),
          renderedBody,
          renderedStats
        )
      ),
      React.createElement(
        'div',
        { className: 'space-y-4' },
        React.createElement(
          'div',
          { className: 'rounded-[24px] border border-slate-700/70 bg-slate-950/40 p-4' },
          React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500' }, 'Inspector summary'),
          React.createElement(
            'div',
            { className: 'mt-3 space-y-3 text-sm text-slate-300' },
            React.createElement(SummaryRow, { label: 'Asset ID', value: assetId ?? 'None' }),
            React.createElement(SummaryRow, { label: 'Reference IDs', value: scene.referenceIds.join(', ') || 'None' }),
            React.createElement(SummaryRow, { label: 'Motion', value: scene.render.motion.preset }),
            React.createElement(SummaryRow, { label: 'Transition', value: scene.render.transition.type }),
            React.createElement(SummaryRow, { label: 'Ready', value: resolvedScene?.status ?? 'unknown' }),
            React.createElement(SummaryRow, { label: 'Render status', value: formatRenderStatusLabel(renderStatus.status) }),
            React.createElement(SummaryRow, { label: 'Narration asset', value: narrationAudioAsset?.filename ?? 'None' })
          )
        ),
        React.createElement(
          'div',
          { className: 'rounded-[24px] border border-slate-700/70 bg-slate-950/40 p-4' },
          React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500' }, 'Readiness'),
          React.createElement('div', { className: 'mt-3 space-y-2 text-sm text-slate-300' }, ...readinessItems)
        )
      )
    )
  );
}

function Chip({ children }: { children: ReactNode }) {
  return React.createElement('span', { className: 'rounded-full border border-slate-700 bg-slate-950/50 px-3 py-1' }, children);
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return React.createElement(
    'div',
    { className: 'rounded-2xl border border-slate-700/70 bg-slate-950/35 px-3 py-3 text-sm' },
    React.createElement('p', { className: 'font-mono text-[10px] uppercase tracking-[0.24em] text-slate-500' }, label),
    React.createElement('p', { className: 'mt-1 text-slate-100' }, value)
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return React.createElement(
    'div',
    { className: 'flex items-start justify-between gap-4 border-b border-slate-700/40 pb-2 last:border-b-0 last:pb-0' },
    React.createElement('span', { className: 'text-slate-500' }, label),
    React.createElement('span', { className: 'text-right text-slate-100' }, value)
  );
}
