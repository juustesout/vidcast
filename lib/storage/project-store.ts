import fs from 'node:fs/promises';
import path from 'node:path';

import { ASPECT_RATIOS, DEFAULT_PROJECT_DESCRIPTION, DEFAULT_PROJECT_DURATION, DEFAULT_PROJECT_TITLE, DEFAULT_RENDER_SETTINGS } from '@/lib/constants';
import { createId } from '@/lib/utils/ids';
import type { Asset } from '@/lib/types/asset';
import type { Project, RenderValidationResult } from '@/lib/types/render';
import type { ReferenceImage } from '@/lib/types/reference';
import type { Scene } from '@/lib/types/scene';
import { normalizeProject } from '@/lib/projects/normalize-project';
import { getAssetUsage, getReferenceAssetUsage, getReferenceUsage } from '@/lib/projects/usage';
import { validateProject } from '@/lib/validation/project-validation';
import { mediaStore } from '@/lib/storage/media-store';
import { withKeyedLock } from '@/lib/utils/keyed-mutex';
import { claimExpiresAtFromNow, claimTokenMatches, generateClaimToken, hashClaimToken, isClaimExpired } from '@/lib/security/claim-token';
import { deleteProjectClaim, readProjectClaim, writeProjectClaim } from './claim-store';
import type { ProjectClaimRecord } from './claim-store';
import { getProjectAssetsRoot, getProjectJsonPath, getProjectPreviewsRoot, getProjectReferencesRoot, getProjectRoot, getProjectRendersRoot, getProjectStudioAssetsRoot, getProjectsRoot } from './storage-paths';

export interface ProjectSummary {
  id: string;
  title: string;
  description: string;
  sceneCount: number;
  assetCount: number;
  referenceCount: number;
  durationTarget: number;
  updatedAt: string;
}

export interface CreateProjectInput {
  title?: string;
  description?: string;
  durationTarget?: number;
  aspectRatio?: Project['aspectRatio'];
  fps?: number;
}

function jsonReviver(_key: string, value: unknown): unknown {
  return value;
}

function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project, jsonReviver)) as Project;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createPlaceholderSvg(label: string, accent = '#9fb4d4'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 675" role="img" aria-label="${label}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111827" />
      <stop offset="100%" stop-color="#1f2937" />
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.35" />
      <stop offset="100%" stop-color="#f2d17b" stop-opacity="0.15" />
    </linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)" />
  <circle cx="250" cy="140" r="180" fill="url(#glow)" />
  <rect x="110" y="110" width="980" height="455" rx="42" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.16)" />
  <text x="600" y="320" fill="#f8fafc" font-family="Arial, sans-serif" font-size="54" text-anchor="middle">${label}</text>
  <text x="600" y="390" fill="#cbd5e1" font-family="Arial, sans-serif" font-size="28" text-anchor="middle">Placeholder asset for local explainer projects</text>
</svg>`;
}

async function ensureDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export class ProjectReadError extends Error {
  readonly code = 'PROJECT_READ_FAILED';
  readonly projectId: string;

  constructor(projectId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectReadError';
    this.projectId = projectId;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}

async function readProjectRaw(projectId: string): Promise<string | null> {
  const projectJsonPath = getProjectJsonPath(projectId);

  try {
    return await fs.readFile(projectJsonPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw new ProjectReadError(projectId, `Failed to read project ${projectId} from disk.`, { cause: error });
  }
}

async function readProjectFile(projectId: string): Promise<Project | null> {
  const raw = await readProjectRaw(projectId);
  if (raw === null) {
    return null;
  }

  try {
    return normalizeProject(JSON.parse(raw) as Project);
  } catch (error) {
    throw new ProjectReadError(projectId, `Project ${projectId} contains invalid or corrupt JSON.`, { cause: error });
  }
}

async function readProjectOwnerTag(projectId: string): Promise<string | undefined> {
  const raw = await readProjectRaw(projectId);
  if (raw === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as { ownerId?: unknown };
    return typeof parsed.ownerId === 'string' ? parsed.ownerId : undefined;
  } catch (error) {
    throw new ProjectReadError(projectId, `Project ${projectId} contains invalid or corrupt JSON.`, { cause: error });
  }
}

/**
 * True when a project carries a not-yet-expired claim capability. Such projects
 * are deliberately excluded from every id-based first-claim path so that only
 * the holder of the minted token can take ownership.
 */
async function hasPendingClaimFile(projectId: string): Promise<boolean> {
  const claim = await readProjectClaim(projectId);
  if (!claim) {
    return false;
  }
  return !isClaimExpired(claim.expiresAt);
}

async function reconcileAssetStatuses(project: Project): Promise<Project> {
  const nextProject = cloneProject(project);
  let changed = false;

  for (const asset of nextProject.assets) {
    if (asset.localPath) {
      const exists = await mediaStore.exists(nextProject.id, asset.localPath);
      if (!exists && asset.status !== 'missing') {
        asset.status = 'missing';
        changed = true;
      }
      if (exists && (asset.status === 'missing' || asset.status === 'imported' || asset.status === 'generated')) {
        asset.status = 'available';
        changed = true;
      }
    }
  }

  return changed ? nextProject : project;
}

async function writeProjectFile(project: Project): Promise<Project> {
  const normalizedProject = normalizeProject(project);
  await ensureDirectory(getProjectRoot(normalizedProject.id));
  await ensureDirectory(getProjectAssetsRoot(normalizedProject.id));
  await ensureDirectory(getProjectStudioAssetsRoot(normalizedProject.id));
  await ensureDirectory(getProjectReferencesRoot(normalizedProject.id));
  await ensureDirectory(getProjectRendersRoot(normalizedProject.id));
  await ensureDirectory(getProjectPreviewsRoot(normalizedProject.id));

  const payload = JSON.stringify(normalizedProject, null, 2);
  const target = getProjectJsonPath(normalizedProject.id);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    await fs.writeFile(temp, payload, 'utf8');
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }

  return normalizedProject;
}

function buildProjectSummary(project: Project): ProjectSummary {
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    sceneCount: project.scenes.length,
    assetCount: project.assets.length,
    referenceCount: project.references.length,
    durationTarget: project.durationTarget,
    updatedAt: project.updatedAt
  };
}

function defaultScene(order: number): Scene {
  return {
    id: createId('scene'),
    order,
    duration: 5,
    type: 'image',
    narration: {
      text: ''
    },
    visual: {
      kind: 'generated_image',
      generation: {
        id: createId('generation'),
        kind: 'image',
        status: 'planned',
        prompt: 'Close-up explanatory scene for the first beat of the video.',
        negativePrompt: '',
        referenceIds: [],
        aspectRatio: DEFAULT_RENDER_SETTINGS.aspectRatio,
        createdAt: nowIso()
      }
    },
    render: {
      motion: { preset: 'zoom_in' },
      transition: { type: 'fade' }
    },
    overlay: {
      type: 'none'
    },
    referenceIds: [],
    notes: ''
  };
}

function buildProjectTemplate(input: CreateProjectInput): Project {
  const createdAt = nowIso();
  const title = input.title?.trim() || DEFAULT_PROJECT_TITLE;

  return {
    id: createId('project'),
    title,
    description: input.description?.trim() || DEFAULT_PROJECT_DESCRIPTION,
    durationTarget: input.durationTarget ?? DEFAULT_PROJECT_DURATION,
    aspectRatio: input.aspectRatio ?? DEFAULT_RENDER_SETTINGS.aspectRatio,
    fps: input.fps ?? DEFAULT_RENDER_SETTINGS.fps,
    createdAt,
    updatedAt: createdAt,
    narration: {
      text: '',
      segments: []
    },
    scenes: [defaultScene(1)],
    assets: [],
    references: [],
    renderSettings: {
      ...DEFAULT_RENDER_SETTINGS
    }
  };
}

function buildSampleProject(): Project {
  const createdAt = nowIso();
  const projectId = createId('project');
  const mainCharacterReference: ReferenceImage = {
    id: 'main_character',
    name: 'Main Character',
    description: 'The person experiencing the hot shower reaction.',
    filePath: 'references/main_character.svg',
    tags: ['character', 'person', 'continuity'],
    metadata: {
      width: 1200,
      height: 675,
      mimeType: 'image/svg+xml',
      filesize: 0
    },
    createdAt,
    updatedAt: createdAt
  };
  const bathroomReference: ReferenceImage = {
    id: 'bathroom',
    name: 'Bathroom',
    description: 'Warm bathroom setting with a shower.',
    filePath: 'references/bathroom.svg',
    tags: ['location', 'bathroom', 'shower'],
    metadata: {
      width: 1200,
      height: 675,
      mimeType: 'image/svg+xml',
      filesize: 0
    },
    createdAt,
    updatedAt: createdAt
  };
  const skinReference: ReferenceImage = {
    id: 'skin_closeup',
    name: 'Skin Close-up',
    description: 'Close-up reference for irritated skin texture.',
    filePath: 'references/skin_closeup.svg',
    tags: ['skin', 'close-up', 'medical'],
    metadata: {
      width: 1200,
      height: 675,
      mimeType: 'image/svg+xml',
      filesize: 0
    },
    createdAt,
    updatedAt: createdAt
  };

  const showerAsset: Asset = {
    id: 'woman_shower',
    type: 'image',
    status: 'imported',
    provenance: 'imported',
    filename: 'woman_shower.svg',
    originalFilename: 'woman_shower.svg',
    localPath: 'assets/woman_shower.svg',
    mimeType: 'image/svg+xml',
    width: 1200,
    height: 675,
    duration: undefined,
    filesize: 0,
    metadata: {
      role: 'hero',
      source: 'local-placeholder'
    },
    createdAt,
    updatedAt: createdAt
  };

  const skinVesselsAsset: Asset = {
    id: 'skin_blood_vessels',
    type: 'image',
    status: 'imported',
    provenance: 'imported',
    filename: 'skin_blood_vessels.svg',
    originalFilename: 'skin_blood_vessels.svg',
    localPath: 'assets/skin_blood_vessels.svg',
    mimeType: 'image/svg+xml',
    width: 1200,
    height: 675,
    duration: undefined,
    filesize: 0,
    metadata: {
      role: 'diagram',
      source: 'local-placeholder'
    },
    createdAt,
    updatedAt: createdAt
  };

  const showerVideoAsset: Asset = {
    id: 'shower_clip',
    type: 'video',
    status: 'planned',
    provenance: 'generated',
    filename: 'shower_clip.mp4',
    originalFilename: 'shower_clip.mp4',
    localPath: undefined,
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    duration: 5,
    filesize: 0,
    metadata: {
      role: 'future-b-roll'
    },
    createdAt,
    updatedAt: createdAt
  };

  const aiImageAsset: Asset = {
    id: 'doctor_skin_generated',
    type: 'image',
    status: 'generated',
    provenance: 'generated',
    filename: 'doctor_skin_generated.svg',
    originalFilename: 'doctor_skin_generated.svg',
    localPath: 'assets/doctor_skin_generated.svg',
    mimeType: 'image/svg+xml',
    width: 1200,
    height: 675,
    filesize: 0,
    metadata: {
      role: 'generated-illustration'
    },
    generation: {
      generationId: 'gen_scene_5_image',
      provider: 'openai',
      model: 'placeholder-model',
      prompt: 'Close-up skin illustration with subtle redness and warm lighting.',
      referenceIds: ['skin_closeup']
    },
    createdAt,
    updatedAt: createdAt
  };

  return {
    id: projectId,
    title: 'Why Does Hot Water Make Your Skin Red?',
    description: 'A compact medical explainer about blood vessels, heat, and temporary skin redness.',
    durationTarget: 45,
    aspectRatio: '16:9',
    fps: 30,
    createdAt,
    updatedAt: createdAt,
    narration: {
      text: 'Have you ever wondered why hot showers can make your skin look red for a few minutes?',
      segments: [
        {
          id: 'segment-1',
          order: 1,
          sceneId: 'sample-scene-1',
          text: 'Have you ever wondered why hot showers can make your skin look red for a few minutes?',
          estimatedDurationSeconds: 6
        }
      ]
    },
    scenes: [
      {
        id: 'sample-scene-1',
        order: 1,
        duration: 8,
        type: 'image',
        narration: { text: 'Have you ever wondered why your skin turns red after a hot shower?' },
        visual: {
          kind: 'asset',
          assetId: 'woman_shower'
        },
        render: {
          motion: { preset: 'zoom_in', intensity: 0.35 },
          transition: { type: 'fade', duration: 0.5 }
        },
        overlay: {
          type: 'callout',
          text: 'Why does this happen?',
          position: 'bottom'
        },
        referenceIds: ['main_character', 'bathroom'],
        notes: 'Intro beat with warm atmosphere.'
      },
      {
        id: 'sample-scene-2',
        order: 2,
        duration: 7,
        type: 'image',
        narration: { text: 'Heat causes blood vessels near the skin to widen.' },
        visual: {
          kind: 'generated_image',
          generation: {
            id: 'gen_scene_2_image',
            kind: 'image',
            status: 'planned',
            provider: 'openai',
            model: 'placeholder-model',
            prompt: 'Illustration of widened blood vessels near the skin after heat exposure.',
            negativePrompt: 'cartoonish, cluttered',
            referenceIds: ['skin_closeup'],
            aspectRatio: '16:9',
            createdAt
          }
        },
        render: {
          motion: { preset: 'pan_right', intensity: 0.25 },
          transition: { type: 'crossfade', duration: 0.5 }
        },
        overlay: {
          type: 'callout',
          text: 'Vessels widen',
          position: 'bottom'
        },
        referenceIds: ['skin_closeup'],
        notes: 'Planned AI image scene without a generated asset yet.'
      },
      {
        id: 'sample-scene-3',
        order: 3,
        duration: 8,
        type: 'video',
        narration: { text: 'A short AI-generated clip could show the heat response in motion.' },
        visual: {
          kind: 'generated_video',
          generation: {
            id: 'gen_scene_3_video',
            kind: 'video',
            status: 'planned',
            provider: 'gemini',
            prompt: 'Short bathroom b-roll clip showing warm water and subtle skin flush.',
            referenceIds: ['main_character', 'bathroom'],
            aspectRatio: '16:9',
            duration: 8,
            createdAt
          }
        },
        render: {
          motion: { preset: 'none' },
          transition: { type: 'fade', duration: 0.4 }
        },
        overlay: {
          type: 'subtitle',
          text: 'AI video planned',
          position: 'bottom'
        },
        referenceIds: ['main_character', 'bathroom'],
        notes: 'Future AI video scene slot.'
      },
      {
        id: 'sample-scene-4',
        order: 4,
        duration: 8,
        type: 'graphic',
        narration: { text: 'That extra blood flow is what creates the red tone.' },
        visual: {
          kind: 'graphic',
          template: 'simple_diagram',
          prompt: 'Simple diagram showing warm water, skin, and increased blood flow.',
          templateData: {
            title: 'Blood Flow',
            value: 'More blood at the surface',
            label: 'Heat expands blood vessels'
          }
        },
        render: {
          motion: { preset: 'zoom_out', intensity: 0.2 },
          transition: { type: 'fade', duration: 0.4 }
        },
        overlay: {
          type: 'callout',
          text: 'More blood near the surface',
          position: 'bottom'
        },
        referenceIds: ['skin_closeup'],
        notes: 'Graphic explanatory beat.'
      },
      {
        id: 'sample-scene-5',
        order: 5,
        duration: 7,
        type: 'image',
        narration: { text: 'The effect can be stronger after longer exposure or hotter water.' },
        visual: {
          kind: 'generated_image',
          assetId: 'doctor_skin_generated',
          generation: {
            id: 'gen_scene_5_image',
            kind: 'image',
            status: 'generated',
            provider: 'openai',
            model: 'placeholder-model',
            prompt: 'Close-up skin illustration with subtle redness and warm lighting.',
            negativePrompt: 'harsh medical imagery',
            referenceIds: ['skin_closeup'],
            aspectRatio: '16:9',
            assetId: 'doctor_skin_generated',
            createdAt,
            completedAt: createdAt
          }
        },
        render: {
          motion: { preset: 'pan_left', intensity: 0.2 },
          transition: { type: 'fade', duration: 0.4 }
        },
        overlay: {
          type: 'statistic',
          text: 'Longer heat = more redness',
          position: 'bottom'
        },
        referenceIds: ['skin_closeup'],
        notes: 'Generated AI image that is already backed by a local asset.'
      },
      {
        id: 'sample-scene-6',
        order: 6,
        duration: 5,
        type: 'text',
        narration: { text: 'And that is why the flush usually disappears shortly after you step out.' },
        visual: {
          kind: 'text',
          text: 'Usually Temporary'
        },
        render: {
          motion: { preset: 'none' },
          transition: { type: 'crossfade', duration: 0.5 }
        },
        overlay: {
          type: 'title',
          text: 'Flush fades away',
          position: 'center'
        },
        referenceIds: ['bathroom'],
        notes: 'Closing text card.'
      }
    ],
    assets: [showerAsset, skinVesselsAsset, showerVideoAsset, aiImageAsset],
    references: [mainCharacterReference, bathroomReference, skinReference],
    renderSettings: {
      ...DEFAULT_RENDER_SETTINGS,
      aspectRatio: ASPECT_RATIOS[0],
      width: 1920,
      height: 1080
    }
  };
}

async function hasProjectDirectories(): Promise<boolean> {
  const entries = await fs.readdir(getProjectsRoot(), { withFileTypes: true });
  return entries.some((entry) => entry.isDirectory());
}

async function ensureSeedProject(): Promise<void> {
  await ensureDirectory(getProjectsRoot());

  if (await hasProjectDirectories()) {
    return;
  }

  await withKeyedLock(PROJECTS_ROOT_LOCK_KEY, async () => {
    if (await hasProjectDirectories()) {
      return;
    }

    const sampleProject = buildSampleProject();
    await writeProjectFile(sampleProject);

    const sampleAssets = [
      {
        path: path.join(getProjectAssetsRoot(sampleProject.id), 'woman_shower.svg'),
        content: createPlaceholderSvg('Woman in Shower', '#9fb4d4')
      },
      {
        path: path.join(getProjectAssetsRoot(sampleProject.id), 'skin_blood_vessels.svg'),
        content: createPlaceholderSvg('Skin Blood Vessels', '#f2d17b')
      },
      {
        path: path.join(getProjectReferencesRoot(sampleProject.id), 'main_character.svg'),
        content: createPlaceholderSvg('Main Character', '#a9c5ff')
      },
      {
        path: path.join(getProjectReferencesRoot(sampleProject.id), 'bathroom.svg'),
        content: createPlaceholderSvg('Bathroom', '#f2d17b')
      },
      {
        path: path.join(getProjectReferencesRoot(sampleProject.id), 'skin_closeup.svg'),
        content: createPlaceholderSvg('Skin Close-up', '#f2d17b')
      }
    ];

    for (const sampleAsset of sampleAssets) {
      await ensureDirectory(path.dirname(sampleAsset.path));
      await fs.writeFile(sampleAsset.path, sampleAsset.content, 'utf8');
    }
  });
}

async function writeProject(project: Project): Promise<Project> {
  const updatedProject: Project = {
    ...cloneProject(project),
    updatedAt: nowIso()
  };

  return writeProjectFile(updatedProject);
}

function projectLockKey(projectId: string): string {
  return `project:${projectId}`;
}

const PROJECTS_ROOT_LOCK_KEY = 'projects:root';

export type ClaimRedemptionStatus = 'claimed' | 'not_found' | 'already_owned' | 'invalid';

export interface ClaimRedemption {
  status: ClaimRedemptionStatus;
  project?: Project;
}

export interface CreateProjectWithClaimResult {
  project: Project;
  claimToken: string;
}

/**
 * Usage report for a reference deletion attempt.
 *
 * `usageSceneIds` keeps its historical meaning: scenes that consume the
 * reference as a generation input. `usageAssetIds` lists generated assets whose
 * provenance trace still points at the reference. Any non-empty list blocks the
 * deletion so a trace can never dangle.
 */
export interface ReferenceDeletionUsage {
  usageSceneIds: string[];
  usageAssetIds: string[];
}

export interface ProjectStore {
  listProjects(ownerId?: string): Promise<ProjectSummary[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(input?: CreateProjectInput, ownerId?: string): Promise<Project>;
  createProjectWithClaim(input?: CreateProjectInput): Promise<CreateProjectWithClaimResult>;
  updateProject(project: Project): Promise<Project>;
  mutateProject(projectId: string, mutator: (current: Project) => Project | Promise<Project>): Promise<Project | null>;
  claimUnownedProjects(ownerId: string): Promise<number>;
  redeemClaim(projectId: string, subject: string, tokenHash: string): Promise<ClaimRedemption>;
  hasPendingClaim(projectId: string): Promise<boolean>;
  deleteProject(id: string): Promise<void>;
  importAsset(projectId: string, file: File): Promise<Asset>;
  importReference(projectId: string, file: File, name: string, description: string, tags: string[]): Promise<ReferenceImage>;
  deleteAsset(projectId: string, assetId: string): Promise<{ usageSceneIds: string[] }>;
  deleteReference(projectId: string, referenceId: string): Promise<ReferenceDeletionUsage>;
  updateReference(projectId: string, referenceId: string, patch: { name?: string; description?: string; tags?: string[] }): Promise<ReferenceImage>;
}

class JsonProjectStore implements ProjectStore {
  async listProjects(ownerId?: string): Promise<ProjectSummary[]> {
    await ensureSeedProject();

    const entries = await fs.readdir(getProjectsRoot(), { withFileTypes: true });
    const projects: ProjectSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      let project: Project | null;
      try {
        project = await readProjectFile(entry.name);
      } catch (error) {
        console.warn(`[project-store] Skipping unreadable project "${entry.name}": ${error instanceof Error ? error.message : 'unknown error'}`);
        continue;
      }

      if (project && (!ownerId || project.ownerId === ownerId)) {
        projects.push(buildProjectSummary(project));
      }
    }

    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getProject(id: string): Promise<Project | null> {
    await ensureSeedProject();
    const project = await readProjectFile(id);
    if (!project) {
      return null;
    }
    return reconcileAssetStatuses(project);
  }

  async createProject(input: CreateProjectInput = {}, ownerId?: string): Promise<Project> {
    const project = buildProjectTemplate(input);
    if (ownerId) {
      project.ownerId = ownerId;
    }
    return withKeyedLock(projectLockKey(project.id), () => writeProjectFile(project));
  }

  async createProjectWithClaim(input: CreateProjectInput = {}): Promise<CreateProjectWithClaimResult> {
    const project = buildProjectTemplate(input);
    const claimToken = generateClaimToken();
    const record: ProjectClaimRecord = {
      tokenHash: hashClaimToken(claimToken),
      createdAt: new Date().toISOString(),
      expiresAt: claimExpiresAtFromNow()
    };

    await withKeyedLock(projectLockKey(project.id), async () => {
      await writeProjectFile(project);
      await writeProjectClaim(project.id, record);
    });

    return { project, claimToken };
  }

  async updateProject(project: Project): Promise<Project> {
    return withKeyedLock(projectLockKey(project.id), () => writeProject(project));
  }

  async mutateProject(projectId: string, mutator: (current: Project) => Project | Promise<Project>): Promise<Project | null> {
    return withKeyedLock(projectLockKey(projectId), async () => {
      const current = await readProjectFile(projectId);
      if (!current) {
        return null;
      }

      const next = await mutator(cloneProject(current));
      return writeProject(next);
    });
  }

  async claimUnownedProjects(ownerId: string): Promise<number> {
    const trimmedOwnerId = ownerId.trim();
    if (!trimmedOwnerId) {
      return 0;
    }

    await ensureSeedProject();

    const entries = await fs.readdir(getProjectsRoot(), { withFileTypes: true });
    let claimed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      let ownerTag: string | undefined;
      try {
        ownerTag = await readProjectOwnerTag(entry.name);
      } catch (error) {
        console.warn(`[project-store] Skipping unreadable project "${entry.name}" during claim: ${error instanceof Error ? error.message : 'unknown error'}`);
        continue;
      }

      if (ownerTag?.trim()) {
        continue;
      }

      // Never auto-claim a project that still holds a claim capability; only the
      // token holder may take it.
      if (await hasPendingClaimFile(entry.name)) {
        continue;
      }

      const didClaim = await withKeyedLock(projectLockKey(entry.name), async () => {
        const current = await readProjectFile(entry.name);
        if (!current || current.ownerId?.trim()) {
          return false;
        }

        await writeProjectFile({ ...current, ownerId: trimmedOwnerId });
        return true;
      });

      if (didClaim) {
        claimed += 1;
      }
    }

    return claimed;
  }

  async redeemClaim(projectId: string, subject: string, tokenHash: string): Promise<ClaimRedemption> {
    const trimmedSubject = subject.trim();
    if (!trimmedSubject) {
      return { status: 'invalid' };
    }

    // Ownership check, token verification and the ownership write all run under
    // the same per-project lock, so two concurrent claims can never both win.
    return withKeyedLock(projectLockKey(projectId), async (): Promise<ClaimRedemption> => {
      const current = await readProjectFile(projectId);
      if (!current) {
        return { status: 'not_found' };
      }

      if (current.ownerId?.trim()) {
        return { status: 'already_owned' };
      }

      const claim = await readProjectClaim(projectId);
      if (!claim) {
        return { status: 'invalid' };
      }

      if (isClaimExpired(claim.expiresAt)) {
        await deleteProjectClaim(projectId);
        return { status: 'invalid' };
      }

      if (!claimTokenMatches(tokenHash, claim.tokenHash)) {
        return { status: 'invalid' };
      }

      const claimed = await writeProject({ ...current, ownerId: trimmedSubject });
      await deleteProjectClaim(projectId);
      return { status: 'claimed', project: claimed };
    });
  }

  async hasPendingClaim(projectId: string): Promise<boolean> {
    return hasPendingClaimFile(projectId);
  }

  async deleteProject(id: string): Promise<void> {
    await withKeyedLock(projectLockKey(id), () => fs.rm(getProjectRoot(id), { recursive: true, force: true }));
  }

  async importAsset(projectId: string, file: File): Promise<Asset> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }
    const { asset } = await mediaStore.saveAsset(projectId, file);

    await this.mutateProject(projectId, (current) => ({ ...current, assets: [...current.assets, asset] }));
    return asset;
  }

  async importReference(projectId: string, file: File, name: string, description: string, tags: string[]): Promise<ReferenceImage> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }
    const { reference } = await mediaStore.saveReference(projectId, file, name, description, tags);

    await this.mutateProject(projectId, (current) => ({ ...current, references: [...current.references, reference] }));
    return reference;
  }

  async deleteAsset(projectId: string, assetId: string): Promise<{ usageSceneIds: string[] }> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }

    const usageSceneIds = getAssetUsage(project, assetId);
    if (usageSceneIds.length > 0) {
      return { usageSceneIds };
    }

    const asset = project.assets.find((entry) => entry.id === assetId);
    if (!asset) {
      return { usageSceneIds: [] };
    }

    await mediaStore.deleteAssetFile(projectId, asset);
    await this.mutateProject(projectId, (current) => ({ ...current, assets: current.assets.filter((entry) => entry.id !== assetId) }));
    return { usageSceneIds: [] };
  }

  async deleteReference(projectId: string, referenceId: string): Promise<ReferenceDeletionUsage> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }

    // Both checks run before anything is touched on disk. Assets are checked
    // too because `asset.generation.referenceIds` is a hard validation input:
    // deleting the reference first would leave a dangling trace that makes the
    // whole project unsavable.
    const usageSceneIds = getReferenceUsage(project, referenceId);
    const usageAssetIds = getReferenceAssetUsage(project, referenceId);
    if (usageSceneIds.length > 0 || usageAssetIds.length > 0) {
      return { usageSceneIds, usageAssetIds };
    }

    const reference = project.references.find((entry) => entry.id === referenceId);
    if (!reference) {
      return { usageSceneIds: [], usageAssetIds: [] };
    }

    await mediaStore.deleteReferenceFile(projectId, reference);
    await this.mutateProject(projectId, (current) => ({ ...current, references: current.references.filter((entry) => entry.id !== referenceId) }));
    return { usageSceneIds: [], usageAssetIds: [] };
  }

  async updateReference(projectId: string, referenceId: string, patch: { name?: string; description?: string; tags?: string[] }): Promise<ReferenceImage> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found.`);
    }

    const exists = project.references.some((entry) => entry.id === referenceId);
    if (!exists) {
      throw new Error(`Reference ${referenceId} not found.`);
    }

    const updated = await this.mutateProject(projectId, (current) => {
      const reference = current.references.find((entry) => entry.id === referenceId);
      if (!reference) {
        throw new Error(`Reference ${referenceId} not found.`);
      }

      reference.name = patch.name?.trim() || reference.name;
      reference.description = patch.description?.trim() ?? reference.description;
      reference.tags = patch.tags ?? reference.tags;
      reference.updatedAt = nowIso();
      return current;
    });

    const reference = updated?.references.find((entry) => entry.id === referenceId);
    if (!reference) {
      throw new Error(`Reference ${referenceId} not found.`);
    }

    return reference;
  }
}

export const projectStore: ProjectStore = new JsonProjectStore();

export function getProjectValidation(project: Project): RenderValidationResult {
  return validateProject(project);
}
