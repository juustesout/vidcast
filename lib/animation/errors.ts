export type AnimationErrorCode =
  | 'animation.template.notFound'
  | 'animation.params.invalid'
  | 'animation.project.notFound'
  | 'animation.scene.notFound'
  | 'animation.asset.notFound'
  | 'animation.destination.unsupported'
  | 'animation.path.unsafe'
  | 'animation.chromium.missing'
  | 'animation.ffmpeg.unavailable'
  | 'animation.render.failed'
  | 'animation.render.timeout'
  | 'animation.output.incomplete';

export class AnimationError extends Error {
  readonly code: AnimationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: AnimationErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AnimationError';
    this.code = code;
    this.details = details;
  }
}

export function animationHttpStatus(code: AnimationErrorCode): number {
  switch (code) {
    case 'animation.template.notFound':
    case 'animation.project.notFound':
    case 'animation.scene.notFound':
    case 'animation.asset.notFound':
      return 404;
    case 'animation.chromium.missing':
    case 'animation.ffmpeg.unavailable':
      return 503;
    case 'animation.render.failed':
    case 'animation.render.timeout':
    case 'animation.output.incomplete':
      return 500;
    default:
      return 400;
  }
}
