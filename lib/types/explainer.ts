export type ScriptVersionSource = 'manual' | 'ai';

export interface ExplainerBrief {
  topic: string;
  goal: string;
  audience: string;
  tone: string;
  targetDurationSeconds: number;
  notes?: string;
}

export interface StoryScriptVersion {
  id: string;
  script: string;
  createdAt: string;
  source: ScriptVersionSource;
}

export interface StoryBeat {
  id: string;
  order: number;
  label?: string;
  // Canonical story material for this beat, not production narration text.
  text: string;
}

export type SceneIntentNarrativeRole = 'hook' | 'setup' | 'explanation' | 'example' | 'transition' | 'summary' | 'cta' | 'custom';

export type SceneIntentStatus = 'draft' | 'approved';

export interface SceneTimingIntent {
  durationSeconds: number;
}

export interface ExplainerStory {
  title: string;
  hook: string;
  script: string;
  beats: StoryBeat[];
  cta: string;
  notes: string;
  versions: StoryScriptVersion[];
}

export interface SceneIntentDraft {
  id: string;
  order: number;
  beatIds: string[];
  label?: string;
  narrativeRole: SceneIntentNarrativeRole;
  visualIntent: string;
  narrationDraft: string;
  timing: SceneTimingIntent;
  notes?: string;
  status: SceneIntentStatus;
  materializedSceneId?: string;
}

export interface ExplainerSpec {
  brief: ExplainerBrief;
  story: ExplainerStory;
  // Reserved for P9.2. P9.1 stores structure only.
  sceneIntents: SceneIntentDraft[];
}
