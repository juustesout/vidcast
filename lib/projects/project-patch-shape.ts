import type { RenderIssue } from '@/lib/types/render';

/**
 * Structural ("shape") validation for incoming project patches.
 *
 * `normalizeProject` and `validateProject` assume well-formed nested objects and
 * arrays. A partial or malformed patch (for example `scenes: {}`, `assets: "x"`,
 * `scenes[0].render: {}` or `scenes[0].narration.attempts: {}`) used to throw a
 * raw `TypeError` deep inside normalization and surface as an HTTP 500. This
 * module turns those structural problems into ordinary validation issues so the
 * API can return the consistent 422 `VALIDATION_FAILED` response instead.
 *
 * Only clearly structural problems (wrong container type) are reported here;
 * missing-but-optional nested fields are defaulted by normalization.
 */

const ARRAY_FIELDS = ['scenes', 'assets', 'references', 'compositions', 'presenterClips'] as const;
const STRING_FIELDS = ['title', 'description'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function push(target: RenderIssue[], code: string, path: string, message: string): void {
  target.push({ severity: 'error', code, path, message });
}

function isValidMotionOrTransition(value: unknown): boolean {
  return typeof value === 'string' || isPlainObject(value);
}

function validateSceneShape(scene: unknown, index: number, issues: RenderIssue[]): void {
  const base = `scenes.${index}`;

  if (!isPlainObject(scene)) {
    push(issues, 'scene.invalid', base, 'Each scene must be an object.');
    return;
  }

  if ('render' in scene && scene.render !== undefined && !isPlainObject(scene.render)) {
    push(issues, 'scene.render.invalid', `${base}.render`, 'scene.render must be an object.');
  } else if (isPlainObject(scene.render)) {
    if ('motion' in scene.render && scene.render.motion !== undefined && !isValidMotionOrTransition(scene.render.motion)) {
      push(issues, 'scene.render.motion.invalid', `${base}.render.motion`, 'scene.render.motion must be a string or object.');
    }
    if ('transition' in scene.render && scene.render.transition !== undefined && !isValidMotionOrTransition(scene.render.transition)) {
      push(issues, 'scene.render.transition.invalid', `${base}.render.transition`, 'scene.render.transition must be a string or object.');
    }
  }

  if ('visual' in scene && scene.visual !== undefined && !isPlainObject(scene.visual)) {
    push(issues, 'scene.visual.invalid', `${base}.visual`, 'scene.visual must be an object.');
  } else if (isPlainObject(scene.visual) && 'style' in scene.visual && scene.visual.style !== undefined && scene.visual.style !== null && !isPlainObject(scene.visual.style)) {
    push(issues, 'scene.visual.style.invalid', `${base}.visual.style`, 'scene.visual.style must be an object.');
  }

  if ('logo' in scene && scene.logo !== undefined && scene.logo !== null && !isPlainObject(scene.logo)) {
    push(issues, 'scene.logo.invalid', `${base}.logo`, 'scene.logo must be an object or null.');
  }

  if ('overlay' in scene && scene.overlay !== undefined && !isPlainObject(scene.overlay)) {
    push(issues, 'scene.overlay.invalid', `${base}.overlay`, 'scene.overlay must be an object.');
  } else if (isPlainObject(scene.overlay)) {
    for (const field of ['style', 'timing'] as const) {
      const value = scene.overlay[field];
      if (value !== undefined && value !== null && !isPlainObject(value)) {
        push(issues, `scene.overlay.${field}.invalid`, `${base}.overlay.${field}`, `scene.overlay.${field} must be an object.`);
      }
    }
  }

  if ('narration' in scene && scene.narration !== undefined) {
    const narration = scene.narration;
    if (typeof narration !== 'string' && !isPlainObject(narration)) {
      push(issues, 'scene.narration.invalid', `${base}.narration`, 'scene.narration must be a string or object.');
    } else if (isPlainObject(narration) && 'attempts' in narration && narration.attempts !== undefined && !Array.isArray(narration.attempts)) {
      push(issues, 'scene.narration.attempts.invalid', `${base}.narration.attempts`, 'scene.narration.attempts must be an array.');
    }
  }

  for (const field of ['motion', 'transition'] as const) {
    if (field in scene && scene[field] !== undefined && !isValidMotionOrTransition(scene[field])) {
      push(issues, `scene.${field}.invalid`, `${base}.${field}`, `scene.${field} must be a string or object.`);
    }
  }
}

function validateExplainerShape(explainer: unknown, issues: RenderIssue[]): void {
  if (!isPlainObject(explainer)) {
    push(issues, 'project.explainer.invalid', 'explainer', 'explainer must be an object.');
    return;
  }

  if ('sceneIntents' in explainer && explainer.sceneIntents !== undefined && !Array.isArray(explainer.sceneIntents)) {
    push(issues, 'project.explainer.sceneIntents.invalid', 'explainer.sceneIntents', 'explainer.sceneIntents must be an array.');
  }

  if ('story' in explainer && explainer.story !== undefined) {
    if (!isPlainObject(explainer.story)) {
      push(issues, 'project.explainer.story.invalid', 'explainer.story', 'explainer.story must be an object.');
    } else if ('beats' in explainer.story && explainer.story.beats !== undefined && !Array.isArray(explainer.story.beats)) {
      push(issues, 'project.explainer.story.beats.invalid', 'explainer.story.beats', 'explainer.story.beats must be an array.');
    }
  }
}

export function collectProjectPatchShapeIssues(patch: unknown): RenderIssue[] {
  const issues: RenderIssue[] = [];
  if (!isPlainObject(patch)) {
    return issues;
  }

  for (const field of ARRAY_FIELDS) {
    if (field in patch && patch[field] !== undefined && !Array.isArray(patch[field])) {
      push(issues, `project.${field}.invalid`, field, `${field} must be an array.`);
    }
  }

  for (const field of STRING_FIELDS) {
    if (field in patch && patch[field] !== undefined && typeof patch[field] !== 'string') {
      push(issues, `project.${field}.invalid`, field, `${field} must be a string.`);
    }
  }

  if ('narration' in patch && patch.narration !== undefined) {
    const narration = patch.narration;
    if (!isPlainObject(narration)) {
      push(issues, 'project.narration.invalid', 'narration', 'narration must be an object.');
    } else if ('segments' in narration && narration.segments !== undefined && !Array.isArray(narration.segments)) {
      push(issues, 'project.narration.segments.invalid', 'narration.segments', 'narration.segments must be an array.');
    }
  }

  if ('renderSettings' in patch && patch.renderSettings !== undefined && !isPlainObject(patch.renderSettings)) {
    push(issues, 'project.renderSettings.invalid', 'renderSettings', 'renderSettings must be an object.');
  } else if (isPlainObject(patch.renderSettings)) {
    for (const field of ['logo', 'graphicStyle', 'studio'] as const) {
      const value = patch.renderSettings[field];
      if (value !== undefined && value !== null && !isPlainObject(value)) {
        push(issues, `project.renderSettings.${field}.invalid`, `renderSettings.${field}`, `renderSettings.${field} must be an object.`);
      }
    }
  }

  if ('explainer' in patch && patch.explainer !== undefined) {
    validateExplainerShape(patch.explainer, issues);
  }

  if ('presenter' in patch && patch.presenter !== undefined) {
    const presenter = patch.presenter;
    if (!isPlainObject(presenter)) {
      push(issues, 'project.presenter.invalid', 'presenter', 'presenter must be an object.');
    } else if ('sceneSettings' in presenter && presenter.sceneSettings !== undefined && !Array.isArray(presenter.sceneSettings)) {
      push(issues, 'project.presenter.sceneSettings.invalid', 'presenter.sceneSettings', 'presenter.sceneSettings must be an array.');
    } else if (Array.isArray(presenter.sceneSettings)) {
      presenter.sceneSettings.forEach((setting, index) => {
        if (!isPlainObject(setting)) {
          push(issues, 'project.presenter.sceneSettings.item.invalid', `presenter.sceneSettings.${index}`, 'Each presenter scene setting must be an object.');
        } else if ('pip' in setting && setting.pip !== undefined && !isPlainObject(setting.pip)) {
          push(issues, 'project.presenter.sceneSettings.pip.invalid', `presenter.sceneSettings.${index}.pip`, 'presenter.sceneSettings.pip must be an object.');
        }
      });
    }
  }

  if (Array.isArray(patch.scenes)) {
    patch.scenes.forEach((scene, index) => validateSceneShape(scene, index, issues));
  }

  return issues;
}
