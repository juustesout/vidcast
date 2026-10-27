export interface WorkspaceTimelineScene {
  sceneId: string;
  order: number;
  start: number;
  end: number;
  duration: number;
}

export interface WorkspaceTimeline {
  totalDuration: number;
  scenes: WorkspaceTimelineScene[];
}

export interface TimeToSceneResult {
  sceneId: string;
  localTime: number;
}

function finiteDuration(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildWorkspaceTimeline(renderPlan: { scenes: Array<{ sceneId: string; order: number; duration: number }> }): WorkspaceTimeline {
  const ordered = renderPlan.scenes.slice().sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.sceneId.localeCompare(right.sceneId);
  });

  const scenes: WorkspaceTimelineScene[] = [];
  let cursor = 0;
  for (const scene of ordered) {
    const duration = finiteDuration(scene.duration);
    scenes.push({
      sceneId: scene.sceneId,
      order: scene.order,
      start: cursor,
      end: cursor + duration,
      duration
    });
    cursor += duration;
  }

  return {
    totalDuration: cursor,
    scenes
  };
}

export function resolveTimeToScene(timeline: WorkspaceTimeline, time: number): TimeToSceneResult | null {
  if (timeline.scenes.length === 0) {
    return null;
  }

  const last = timeline.scenes[timeline.scenes.length - 1];
  if (timeline.totalDuration <= 0) {
    return { sceneId: timeline.scenes[0].sceneId, localTime: 0 };
  }

  const clamped = Number.isFinite(time) ? Math.min(Math.max(time, 0), timeline.totalDuration) : 0;

  for (let index = 0; index < timeline.scenes.length; index += 1) {
    const scene = timeline.scenes[index];
    const isLast = index === timeline.scenes.length - 1;
    if (isLast) {
      if (clamped >= scene.start) {
        return {
          sceneId: scene.sceneId,
          localTime: Math.min(Math.max(clamped - scene.start, 0), scene.duration)
        };
      }
      continue;
    }

    if (clamped >= scene.start && clamped < scene.end) {
      return {
        sceneId: scene.sceneId,
        localTime: clamped - scene.start
      };
    }
  }

  return {
    sceneId: last.sceneId,
    localTime: last.duration
  };
}

export function formatWorkspaceClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0.0s';
  }
  return `${seconds.toFixed(1)}s`;
}
