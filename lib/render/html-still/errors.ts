export type HtmlStillErrorCode =
  | 'html.invalid'
  | 'html.tooLarge'
  | 'html.template.unknown'
  | 'html.template.data.invalid'
  | 'html.chromium.missing'
  | 'html.render.failed'
  | 'html.render.timeout'
  | 'html.output.incomplete'
  | 'html.output.invalid'
  | 'html.project.notFound'
  | 'html.scene.notFound'
  | 'html.scene.invalidVisualKind'
  | 'html.scene.alreadyRunning'
  | 'html.image.missing'
  | 'html.image.invalid'
  | 'html.image.unsafe';

export class HtmlStillError extends Error {
  readonly code: HtmlStillErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: HtmlStillErrorCode, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HtmlStillError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function htmlStillHttpStatus(code: HtmlStillErrorCode): number {
  switch (code) {
    case 'html.project.notFound':
    case 'html.scene.notFound':
      return 404;
    case 'html.chromium.missing':
      return 503;
    case 'html.render.timeout':
      return 504;
    case 'html.render.failed':
    case 'html.output.incomplete':
    case 'html.output.invalid':
      return 500;
    case 'html.scene.alreadyRunning':
      return 409;
    default:
      return 400;
  }
}
