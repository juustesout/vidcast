import fs from 'node:fs/promises';
import path from 'node:path';

import { deriveNarrationFreshness } from '@/lib/generation/narration-freshness';
import { FFprobeError, parseDurationSeconds, probeMedia, type FFprobeResult } from '@/lib/render/ffprobe';
import { resolveSelectedMusicAsset } from '@/lib/render/music-mix';
import { deriveCompositionArtifactStatus, deriveSceneRenderStatus } from '@/lib/render/render-status';
import { resolveRenderPlan } from '@/lib/render/scene-resolver';
import { sceneDurationMatches } from '@/lib/render/scene-timing';
import {
  FileMandateSpendLedger,
  MandateBudgetError,
  type MandateSpendFile
} from '@/lib/spend/mandate-spend';
import { isMandateLive, readProjectMandate, resolveMandateStatus } from '@/lib/storage/mandate-store';
import { getProjectMandateSpendPath, getProjectRoot } from '@/lib/storage/storage-paths';
import type { MandateBudgetSettings, ProductionMandate } from '@/lib/types/mandate';
import type { CompositionArtifact, Project } from '@/lib/types/render';

import { deriveProductionPlan } from './production-planner';
import type { ProductionRunnerEvent } from './production-runner';
import type { HeadlessRunSnapshot, HeadlessRunStatus } from './run-types';

export type ProductionQcStatus = 'passed' | 'failed' | 'partial';

export interface ProductionQcOutputProbe {
  compositionId: string;
  downloadPath: string;
  codec?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  hasAudio: boolean;
  audioCodec?: string;
  filesize?: number;
}

export interface ProductionQcSceneCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ProductionQcIssue {
  code: string;
  message: string;
  sceneId?: string;
}

export interface ProductionQcMandateStatus {
  available: boolean;
  live?: boolean;
  status?: string;
  mandateId?: string;
  budgets?: MandateBudgetSettings;
  spentUsd?: number;
  reservedCount?: number;
}

export interface ProductionQcRecovery {
  paidSubmitRequired: false;
  resumeSafe: boolean;
  notes: string[];
}

export interface ProductionQcReport {
  projectId: string;
  runId: string;
  generatedAt: string;
  runStatus: HeadlessRunStatus;
  qcStatus: ProductionQcStatus;
  output: ProductionQcOutputProbe | null;
  scenes: ProductionQcSceneCounts;
  recoveryAttempts: number;
  warnings: string[];
  failures: ProductionQcIssue[];
  mandate: ProductionQcMandateStatus | null;
  recovery: ProductionQcRecovery;
}

export interface ProductionQcInput {
  run: Pick<
    HeadlessRunSnapshot,
    | 'runId'
    | 'projectId'
    | 'status'
    | 'summary'
    | 'completedActionIds'
    | 'failedActionIds'
    | 'unresolvedActions'
    | 'acceptedConfig'
  >;
  project: Project | null;
  events?: ProductionRunnerEvent[];
}

export interface ProductionQcContext {
  probeMedia?: (filePath: string) => Promise<FFprobeResult>;
  statFile?: (filePath: string) => Promise<{ size: number } | null>;
  readMandate?: (projectId: string) => Promise<ProductionMandate | null>;
  readSpendSnapshot?: (projectId: string) => Promise<MandateSpendFile | null>;
  now?: () => string;
}

const FATAL_OUTPUT_CODES = new Set([
  'qc.output.missing',
  'qc.output.empty',
  'qc.output.unreadable',
  'qc.output.codec',
  'qc.output.resolution',
  'qc.output.fps',
  'qc.output.duration',
  'qc.output.audio_missing',
  'qc.output.audio_duration',
  'qc.output.path_unsafe',
  'qc.ffprobe.unavailable'
]);

const COMPOSE_ACTION_ID = 'project:final_compose';

function parseFraction(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const [numerator, denominator] = value.split('/').map((entry) => Number.parseFloat(entry));
  if (!Number.isFinite(numerator)) {
    return undefined;
  }
  if (!denominator || !Number.isFinite(denominator)) {
    return numerator;
  }
  if (denominator === 0) {
    return undefined;
  }
  return numerator / denominator;
}

function productionExpectsAudio(project: Project): boolean {
  const hasNarration = project.scenes.some(
    (scene) => Boolean(scene.narration?.text?.trim()) || Boolean(scene.narration?.audioAssetId)
  );
  const hasMusic = Boolean(resolveSelectedMusicAsset(project));
  const hasPresenter = Boolean(project.presenter?.enabled);
  return hasNarration || hasMusic || hasPresenter;
}

function downloadPathFor(projectId: string, compositionId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/compositions/${encodeURIComponent(compositionId)}/file`;
}

function resolveCompositionPath(projectId: string, relativePath: string): string | null {
  const projectRoot = path.resolve(getProjectRoot(projectId));
  const absolutePath = path.resolve(projectRoot, relativePath.replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!absolutePath.startsWith(projectRoot)) {
    return null;
  }
  return absolutePath;
}

async function defaultStatFile(filePath: string): Promise<{ size: number } | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    return null;
  }
  return { size: stat.size };
}

async function defaultReadSpendSnapshot(projectId: string): Promise<MandateSpendFile | null> {
  try {
    return await new FileMandateSpendLedger({ filePath: getProjectMandateSpendPath(projectId) }).snapshot();
  } catch {
    return null;
  }
}

function countRecoveryAttempts(events: ProductionRunnerEvent[]): number {
  return events.filter((event) => event.code === 'action_retrying' || event.code === 'run_recovered').length;
}

function skippedSceneIds(events: ProductionRunnerEvent[]): Set<string> {
  const skipped = new Set<string>();
  for (const event of events) {
    if (event.code === 'action_skipped' && event.sceneId) {
      skipped.add(event.sceneId);
    }
  }
  return skipped;
}

async function inspectOutput(
  project: Project,
  artifact: CompositionArtifact | undefined,
  expectsAudio: boolean,
  context: ProductionQcContext,
  failures: ProductionQcIssue[],
  warnings: string[]
): Promise<ProductionQcOutputProbe | null> {
  if (!artifact) {
    return null;
  }

  const outputPath = resolveCompositionPath(project.id, artifact.outputPath);
  if (!outputPath) {
    failures.push({
      code: 'qc.output.path_unsafe',
      message: 'Composition output path is outside the project root.'
    });
    return {
      compositionId: artifact.compositionId,
      downloadPath: downloadPathFor(project.id, artifact.compositionId),
      hasAudio: false
    };
  }

  const statFile = context.statFile ?? defaultStatFile;
  const stat = await statFile(outputPath);
  if (!stat) {
    failures.push({
      code: 'qc.output.missing',
      message: 'Final MP4 is missing on disk.'
    });
    return {
      compositionId: artifact.compositionId,
      downloadPath: downloadPathFor(project.id, artifact.compositionId),
      hasAudio: false
    };
  }
  if (stat.size <= 0) {
    failures.push({
      code: 'qc.output.empty',
      message: 'Final MP4 exists but is empty.'
    });
    return {
      compositionId: artifact.compositionId,
      downloadPath: downloadPathFor(project.id, artifact.compositionId),
      filesize: stat.size,
      hasAudio: false
    };
  }

  const probeFn = context.probeMedia ?? probeMedia;
  let probe: FFprobeResult;
  try {
    probe = await probeFn(outputPath);
  } catch (error) {
    if (error instanceof FFprobeError && error.reason === 'spawn_error') {
      failures.push({
        code: 'qc.ffprobe.unavailable',
        message: 'ffprobe could not be started to inspect the final MP4.'
      });
    } else {
      failures.push({
        code: 'qc.output.unreadable',
        message: 'Final MP4 could not be read or is corrupt.'
      });
    }
    return {
      compositionId: artifact.compositionId,
      downloadPath: downloadPathFor(project.id, artifact.compositionId),
      filesize: stat.size,
      hasAudio: false
    };
  }

  const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
  const audioStream = probe.streams?.find((stream) => stream.codec_type === 'audio');
  const codecName = videoStream?.codec_name;
  const formatName = probe.format?.format_name ?? '';
  const width = videoStream?.width;
  const height = videoStream?.height;
  const fps = parseFraction(videoStream?.avg_frame_rate) ?? parseFraction(videoStream?.r_frame_rate);
  const duration = parseDurationSeconds(probe.format?.duration) ?? parseDurationSeconds(videoStream?.duration);
  const audioDuration = parseDurationSeconds(audioStream?.duration);
  const hasAudio = Boolean(audioStream);

  const output: ProductionQcOutputProbe = {
    compositionId: artifact.compositionId,
    downloadPath: downloadPathFor(project.id, artifact.compositionId),
    codec: codecName,
    width,
    height,
    fps,
    duration,
    hasAudio,
    audioCodec: audioStream?.codec_name,
    filesize: stat.size
  };

  if (!videoStream) {
    failures.push({
      code: 'qc.output.unreadable',
      message: 'Final MP4 has no readable video stream.'
    });
    return output;
  }

  if (codecName !== 'h264' || !formatName.includes('mp4')) {
    failures.push({
      code: 'qc.output.codec',
      message: `Final output codec/container is ${codecName ?? 'unknown'}/${formatName || 'unknown'}, expected h264/mp4.`
    });
  }

  const expectedWidth = project.renderSettings.width;
  const expectedHeight = project.renderSettings.height;
  if (width !== expectedWidth || height !== expectedHeight) {
    failures.push({
      code: 'qc.output.resolution',
      message: `Final output resolution is ${width ?? 0}x${height ?? 0}, expected ${expectedWidth}x${expectedHeight}.`
    });
  }

  const expectedFps = project.renderSettings.fps;
  if (typeof fps === 'number' && Math.abs(fps - expectedFps) > 0.5) {
    failures.push({
      code: 'qc.output.fps',
      message: `Final output frame rate is ${fps}, expected ${expectedFps}.`
    });
  }

  const expectedDuration = artifact.duration;
  if (typeof duration !== 'number' || !sceneDurationMatches(duration, expectedDuration, expectedFps)) {
    failures.push({
      code: 'qc.output.duration',
      message: `Final output duration is ${duration ?? 'unknown'}s, expected ${expectedDuration}s.`
    });
  }

  if (expectsAudio && !hasAudio) {
    failures.push({
      code: 'qc.output.audio_missing',
      message: 'Final output is missing a required audio stream.'
    });
  } else if (!expectsAudio && !hasAudio) {
    warnings.push('Audio is optional for this production and no audio stream is present.');
  }

  if (hasAudio && typeof duration === 'number' && typeof audioDuration === 'number') {
    if (!sceneDurationMatches(audioDuration, duration, expectedFps)) {
      failures.push({
        code: 'qc.output.audio_duration',
        message: `Audio duration ${audioDuration}s does not match video duration ${duration}s.`
      });
    }
  } else if (hasAudio && audioDuration === undefined) {
    warnings.push('Audio stream is present but duration metadata is unavailable.');
  }

  return output;
}

async function inspectMandate(
  projectId: string,
  context: ProductionQcContext,
  warnings: string[]
): Promise<ProductionQcMandateStatus | null> {
  const readMandate = context.readMandate ?? readProjectMandate;
  let mandate: ProductionMandate | null;
  try {
    mandate = await readMandate(projectId);
  } catch {
    warnings.push('Mandate status could not be read.');
    return { available: false };
  }

  if (!mandate) {
    return null;
  }

  const status = resolveMandateStatus(mandate);
  const result: ProductionQcMandateStatus = {
    available: true,
    live: isMandateLive(mandate),
    status,
    mandateId: mandate.mandateId,
    budgets: mandate.budgets
  };

  const readSpend = context.readSpendSnapshot ?? defaultReadSpendSnapshot;
  try {
    const spend = await readSpend(projectId);
    if (spend && spend.mandateId && spend.mandateId !== mandate.mandateId) {
      warnings.push('Mandate spend ledger does not match the current mandate.');
    } else if (spend) {
      result.spentUsd = spend.entries.reduce((sum, entry) => {
        const usd = entry.observedUsd ?? entry.estimatedUsd;
        return typeof usd === 'number' && Number.isFinite(usd) ? sum + usd : sum;
      }, 0);
      result.reservedCount = spend.entries.filter((entry) => entry.status === 'reserved').length;
    }
  } catch (error) {
    if (error instanceof MandateBudgetError) {
      warnings.push('Mandate spend ledger is unavailable.');
    } else {
      warnings.push('Mandate spend could not be read.');
    }
  }

  return result;
}

function classifyScenes(
  project: Project,
  run: ProductionQcInput['run'],
  events: ProductionRunnerEvent[],
  failures: ProductionQcIssue[],
  warnings: string[]
): ProductionQcSceneCounts {
  const renderPlan = resolveRenderPlan(project);
  const skipped = skippedSceneIds(events);
  const failedActionIds = new Set(run.failedActionIds);
  const plan = deriveProductionPlan(project, {
    completedActionIds: run.completedActionIds,
    failedActionIds: run.failedActionIds,
    mode: run.acceptedConfig.policy.mode
  });

  let passed = 0;
  let failed = 0;
  let skippedCount = 0;

  for (const scene of project.scenes) {
    const renderStatus = deriveSceneRenderStatus(project, scene, renderPlan);
    const sceneFailedActions = plan.actions.filter(
      (action) => action.sceneId === scene.id && (action.status === 'failed' || failedActionIds.has(action.id))
    );
    const sceneSkipped = skipped.has(scene.id) && sceneFailedActions.length === 0 && renderStatus.status !== 'rendered';
    const narration = deriveNarrationFreshness(project, scene);
    const narrationFailed = scene.narration?.status === 'failed' || Boolean(scene.narration?.error);
    const blocking = renderStatus.problems.some((problem) => problem.severity === 'blocking');
    const incomplete =
      renderStatus.status === 'not_rendered' ||
      renderStatus.status === 'render_failed' ||
      renderStatus.status === 'stale' ||
      blocking;

    if (narrationFailed) {
      failures.push({
        code: 'qc.narration.failed',
        message: scene.narration?.error || `Scene ${scene.order} narration failed.`,
        sceneId: scene.id
      });
    }

    if (sceneFailedActions.length > 0) {
      for (const action of sceneFailedActions) {
        failures.push({
          code: 'qc.actions.failed',
          message: action.reason || `Required action ${action.type} failed for scene ${scene.order}.`,
          sceneId: scene.id
        });
      }
      failed += 1;
      continue;
    }

    if (sceneSkipped) {
      skippedCount += 1;
      continue;
    }

    if (incomplete) {
      failures.push({
        code: 'qc.scenes.incomplete',
        message:
          renderStatus.status === 'stale'
            ? `Scene ${scene.order} render is stale.`
            : `Scene ${scene.order} was not fully processed.`,
        sceneId: scene.id
      });
      failed += 1;
      continue;
    }

    if (narration.state === 'stale') {
      warnings.push(`Scene ${scene.order} narration no longer matches current inputs.`);
    }

    passed += 1;
  }

  return {
    total: project.scenes.length,
    passed,
    failed,
    skipped: skippedCount
  };
}

function deriveQcStatus(input: {
  runStatus: HeadlessRunStatus;
  failures: ProductionQcIssue[];
  scenes: ProductionQcSceneCounts;
  outputValid: boolean;
}): ProductionQcStatus {
  const fatalOutput = input.failures.some((issue) => FATAL_OUTPUT_CODES.has(issue.code));
  if (fatalOutput) {
    return 'failed';
  }

  if (input.scenes.passed > 0 && (input.scenes.failed > 0 || input.scenes.skipped > 0 || input.runStatus === 'partial')) {
    return 'partial';
  }

  if (input.failures.length > 0 || input.scenes.failed > 0 || !input.outputValid) {
    return 'failed';
  }

  if (input.runStatus === 'failed' || input.runStatus === 'unresolved') {
    return 'failed';
  }

  return 'passed';
}

export async function evaluateProductionQc(
  input: ProductionQcInput,
  context: ProductionQcContext = {}
): Promise<ProductionQcReport> {
  const generatedAt = context.now ? context.now() : new Date().toISOString();
  const events = input.events ?? [];
  const failures: ProductionQcIssue[] = [];
  const warnings: string[] = [];
  const recoveryAttempts = countRecoveryAttempts(events);

  if (!input.project) {
    failures.push({
      code: 'qc.project.missing',
      message: `Project ${input.run.projectId} could not be read for QC.`
    });
    return {
      projectId: input.run.projectId,
      runId: input.run.runId,
      generatedAt,
      runStatus: input.run.status,
      qcStatus: 'failed',
      output: null,
      scenes: { total: 0, passed: 0, failed: 0, skipped: 0 },
      recoveryAttempts,
      warnings,
      failures,
      mandate: null,
      recovery: {
        paidSubmitRequired: false,
        resumeSafe: false,
        notes: ['QC could not load the project. Resume is not safe until the project is readable.']
      }
    };
  }

  const project = input.project;
  const renderPlan = resolveRenderPlan(project);
  const artifactStatus = deriveCompositionArtifactStatus(project, renderPlan);
  const artifact = artifactStatus.artifact ?? (project.compositions ?? [])[0];
  const composeCompleted = input.run.completedActionIds.includes(COMPOSE_ACTION_ID);
  const expectsAudio = productionExpectsAudio(project);

  const unresolvedRequired = input.run.unresolvedActions.filter(
    (action) => action.status === 'ready' || action.status === 'waiting_dependency' || action.status === 'blocked'
  );
  if (unresolvedRequired.length > 0) {
    for (const action of unresolvedRequired) {
      failures.push({
        code: 'qc.actions.unresolved',
        message: action.reason || `Required action ${action.type} is unresolved.`,
        sceneId: action.sceneId
      });
    }
  }

  const scenes = classifyScenes(project, input.run, events, failures, warnings);

  if (input.run.failedActionIds.includes(COMPOSE_ACTION_ID)) {
    failures.push({
      code: 'qc.actions.failed',
      message: 'Final compose failed.'
    });
  }

  if (artifactStatus.status === 'stale') {
    for (const reason of artifactStatus.reasons) {
      failures.push({
        code: 'qc.composition.stale',
        message: reason
      });
    }
  }

  if (!artifact && composeCompleted) {
    failures.push({
      code: 'qc.composition.missing',
      message: 'Compose completed but no composition artifact is stored.'
    });
  } else if (!artifact && scenes.failed === 0 && unresolvedRequired.length === 0 && project.scenes.length > 0) {
    failures.push({
      code: 'qc.composition.missing',
      message: 'Project has no final composition artifact.'
    });
  }

  const output = await inspectOutput(project, artifact, expectsAudio, context, failures, warnings);
  const mandate = await inspectMandate(project.id, context, warnings);

  const outputValid = Boolean(output) && !failures.some((issue) => FATAL_OUTPUT_CODES.has(issue.code));
  const qcStatus = deriveQcStatus({
    runStatus: input.run.status,
    failures,
    scenes,
    outputValid: outputValid && Boolean(artifact) && artifactStatus.status === 'current'
  });

  const uniqueFailures = dedupeIssues(failures);
  const resumeSafe =
    input.run.unresolvedActions.some((action) => action.type === 'video_poll' || action.type === 'presenter_poll') ||
    uniqueFailures.some((issue) => issue.code === 'qc.scenes.incomplete' || issue.code === 'qc.composition.missing');

  const notes: string[] = [];
  if (resumeSafe) {
    notes.push('Resume the existing run to retry local render/compose or re-poll existing provider jobs. Do not submit new paid work.');
  } else if (qcStatus !== 'passed') {
    notes.push('QC did not pass. Do not start a new paid submit to make QC succeed.');
  }

  return {
    projectId: project.id,
    runId: input.run.runId,
    generatedAt,
    runStatus: input.run.status,
    qcStatus,
    output,
    scenes,
    recoveryAttempts,
    warnings: Array.from(new Set(warnings)),
    failures: uniqueFailures,
    mandate,
    recovery: {
      paidSubmitRequired: false,
      resumeSafe,
      notes
    }
  };
}

function dedupeIssues(issues: ProductionQcIssue[]): ProductionQcIssue[] {
  const seen = new Set<string>();
  const result: ProductionQcIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}:${issue.sceneId ?? ''}:${issue.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(issue);
  }
  return result;
}
