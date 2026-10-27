'use client';

import type { MouseEvent } from 'react';

import type { CompositionArtifactStatus } from '@/lib/render/render-status';
import { formatWorkspaceClock, type WorkspaceTimeline } from '@/lib/workspace/timeline';

interface ProgramBarProps {
  timeline: WorkspaceTimeline;
  selectedSceneId?: string;
  compositionStatus: CompositionArtifactStatus['status'];
  compositionReason?: string;
  onSeek: (time: number) => void;
}

function statusLabel(status: CompositionArtifactStatus['status']): string {
  if (status === 'current') {
    return 'Final render current';
  }
  if (status === 'stale') {
    return 'Final render stale';
  }
  return 'Final render missing';
}

export function ProgramBar({
  timeline,
  selectedSceneId,
  compositionStatus,
  compositionReason,
  onSeek
}: ProgramBarProps): JSX.Element {
  const total = timeline.totalDuration;

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = rect.width;
    const ratio = width > 0 ? Math.min(Math.max((event.clientX - rect.left) / width, 0), 1) : 0;
    onSeek(ratio * total);
  }

  return (
    <div className="space-y-2 rounded-[24px] border border-slate-700/70 bg-slate-950/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-slate-500">Program</p>
        <span data-composition-status={compositionStatus}>{statusLabel(compositionStatus)}</span>
      </div>
      <button
        type="button"
        aria-label="Program timeline"
        className="block w-full text-left"
        onClick={(event) => handleClick(event)}
      >
        <div className="flex h-10 overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-900">
          {timeline.scenes.length === 0 ? (
            <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">No scenes</div>
          ) : (
            timeline.scenes.map((scene) => {
              const width = total > 0 ? Math.max((scene.duration / total) * 100, scene.duration === 0 ? 0 : 2) : 100 / timeline.scenes.length;
              const selected = scene.sceneId === selectedSceneId;
              return (
                <div
                  key={scene.sceneId}
                  data-scene-id={scene.sceneId}
                  className={`h-full border-r border-slate-800 last:border-r-0 ${selected ? 'bg-amber-300/40' : 'bg-slate-700/60'}`}
                  style={{ width: `${width}%` }}
                />
              );
            })
          )}
        </div>
      </button>
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span>0.0s</span>
        <span data-total-duration={String(total)}>{formatWorkspaceClock(total)}</span>
      </div>
      {compositionStatus !== 'current' ? (
        <p className="text-xs text-amber-200">
          {compositionReason || 'Plan bar navigates scenes only. Global video seek needs a current final MP4.'}
        </p>
      ) : (
        <p className="text-xs text-slate-400">Click the bar to jump to a scene on the planned timeline.</p>
      )}
    </div>
  );
}
