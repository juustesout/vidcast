import type { CompositionPlan } from '@/lib/types/render';
import type { PresenterOverlayPlacement } from '@/lib/types/presenter';

function formatSeconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0';
}

function placementOverlayExpressions(placement: PresenterOverlayPlacement, canvasWidth: number): { x: string; y: string } {
  if (placement.layout === 'fullscreen' || !placement.pip) {
    return { x: '0', y: '0' };
  }
  const position = placement.pip.position;
  const margin = Math.round(canvasWidth * placement.pip.marginRatio);
  if (position === 'top_left') {
    return { x: String(margin), y: String(margin) };
  }
  if (position === 'top_right') {
    return { x: `W-w-${margin}`, y: String(margin) };
  }
  if (position === 'bottom_left') {
    return { x: String(margin), y: `H-h-${margin}` };
  }
  return { x: `W-w-${margin}`, y: `H-h-${margin}` };
}

export function buildPresenterOverlayArgs(
  baseVideoPath: string,
  outputPath: string,
  plan: CompositionPlan
): string[] {
  const presenter = plan.presenter;
  if (!presenter || presenter.placements.length === 0) {
    return [
      '-y',
      '-i',
      baseVideoPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outputPath
    ];
  }

  const args: string[] = ['-y', '-i', baseVideoPath];
  for (const placement of presenter.placements) {
    args.push('-i', placement.clipPath);
  }

  const filters: string[] = [];
  let baseLabel = '0:v';
  const canvasWidth = plan.width;
  const canvasHeight = plan.height;

  presenter.placements.forEach((placement, index) => {
    const inputLabel = `${index + 1}:v`;
    const offset = Math.max(0, placement.startOffsetSeconds);
    const available = placement.clipDuration - offset;
    if (available <= 0) {
      return;
    }
    // Hold the last usable clip frame when the clip is shorter than the scene
    // segment. This keeps the presenter on screen through the scene end
    // instead of briefly revealing the underlying base video.
    const sourceDuration = Math.max(0.001, Math.min(placement.duration, available));
    const pad = Math.max(0, placement.duration - sourceDuration);
    const end = placement.startTime + placement.duration;

    const clipFilters: string[] = [
      `trim=start=${formatSeconds(offset)}:duration=${formatSeconds(sourceDuration)}`
    ];
    if (pad > 0.001) {
      clipFilters.push(`tpad=stop_mode=clone:stop_duration=${formatSeconds(pad)}`);
    }

    if (placement.layout === 'pip' && placement.pip) {
      const pipWidth = Math.max(2, Math.round(canvasWidth * placement.pip.widthRatio));
      clipFilters.push(`scale=w=${pipWidth}:h=-2`);
    } else {
      clipFilters.push(`scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=increase`);
      clipFilters.push(`crop=${canvasWidth}:${canvasHeight}`);
    }

    clipFilters.push('setsar=1');
    clipFilters.push('format=yuva420p');
    clipFilters.push(`fps=${plan.fps}`);
    clipFilters.push(`setpts=PTS-STARTPTS+${formatSeconds(placement.startTime)}/TB`);

    const clipLabel = `p${index}`;
    filters.push(`[${inputLabel}]${clipFilters.join(',')}[${clipLabel}]`);

    const { x, y } = placementOverlayExpressions(placement, canvasWidth);
    const nextLabel = `v${index}`;
    const enable = `between(t,${formatSeconds(placement.startTime)},${formatSeconds(end)})`;
    filters.push(
      `[${baseLabel}][${clipLabel}]overlay=x=${x}:y=${y}:eof_action=pass:enable='${enable}'[${nextLabel}]`
    );
    baseLabel = nextLabel;
  });

  return [
    ...args,
    '-filter_complex',
    filters.join(';'),
    '-map',
    `[${baseLabel}]`,
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(plan.fps),
    '-c:a',
    'copy',
    '-t',
    formatSeconds(plan.totalDuration),
    '-movflags',
    '+faststart',
    outputPath
  ];
}
