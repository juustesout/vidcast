# Local Explainer Studio Blueprint

This document captures the current high-level product and architecture direction for the project.

## Positioning

This is not just an FFmpeg editor.

It is an AI-assisted video compiler where AI is a first-class source of assets and planning input.

The core idea is:

- an LLM can act as planner or director
- AI image generation can create scene visuals
- AI video generation can be used selectively for scenes that justify the cost
- FFmpeg remains the deterministic local renderer
- the application itself owns the structured video model

The "model" here means an internal video schema and planning system, not training a foundation model.

## Delivery Roadmap

```text
P0  Foundation                         DONE
P1  Video Model / Project Schema       next
P2  Asset & Reference Pipeline
P3  Image Generation Providers
P4  AI Video Provider Architecture
P5  FFmpeg Scene Renderer
P6  Multi-scene Composition
P7  Audio / TTS / Subtitles
P8  Preview + Render UX
P9  Explainer Production Workflow
```

## System Shape

```text
                    VIDEO MODEL
                         |
          +--------------+--------------+
          |              |              |
          v              v              v
       SCRIPT          VISUALS        AUDIO
          |              |              |
          |         +----+----+         |
          |         |         |         |
          |         v         v         |
          |       IMAGE      VIDEO      |
          |         |         |         |
          |         +----+----+         |
          |              |              |
          +--------------+--------------+
                         v
                    RENDER PLAN
                         |
                         v
                       FFMPEG
                         |
                         v
                        MP4
```

The Video Model is the heart of the system.

## P1 Focus: Video Model

The next phase should make the existing project and scene types more semantically expressive.

We want scenes to describe intent, generation, references, and rendering hints in a structured way.

Example shape:

```json
{
  "id": "scene-03",
  "duration": 8,
  "narration": {
    "text": "Warm water causes the blood vessels near the surface of your skin to expand."
  },
  "visual": {
    "kind": "image",
    "generation": {
      "provider": "openai",
      "prompt": "medical illustration...",
      "references": ["skin-reference-01"]
    },
    "motion": {
      "preset": "zoom_in",
      "intensity": 0.35
    }
  },
  "overlay": {
    "type": "callout",
    "text": "Blood vessels expand"
  }
}
```

The goal is that an LLM can eventually design a video plan, not just point to a flat image path.

## P2 Focus: Asset And Reference Pipeline

We need a clean split between:

- references used to steer AI generation
- generated or imported assets used in the final production

Expected structure:

```text
references/
  woman-main.jpg
  bathroom.jpg
  skin-closeup.jpg

assets/
  img_001.png
  img_002.png
  video_001.mp4
```

Asset metadata should eventually track:

- source: generated, imported, stock
- provider: openai, gemini, local, other
- prompt
- references
- model
- dimensions
- duration
- generation metadata

This is important for reproducibility, cost tracking, and regeneration.

## P3 Focus: Image Generation Providers

Provider integrations should sit behind a generic interface.

```ts
interface ImageGenerator {
  generate(request: ImageGenerationRequest): Promise<GeneratedAsset>;
}
```

Desired shape:

```text
ImageGenerator
       |
  +----+-----+
  |          |
  v          v
OpenAI     Gemini
```

React and scene editing should not know provider-specific details.

## P4 Focus: AI Video Providers

Video generation should follow the same provider abstraction pattern.

```text
VideoGenerator
       |
  +----+--------+
  |    |        |
  v    v        v
OpenAI Gemini  Local
```

Scenes should also carry a generation strategy, for example:

- static
- image
- ai_video
- stock_video
- graphic

That keeps costs under control by using AI video only where it is worth it.

## P5 Focus: FFmpeg Scene Renderer

Input:

- Scene or resolved renderable scene data

Output:

- `scene-001.mp4`

Initial pipelines:

- image -> scale -> crop -> zoom/pan -> fade -> mp4
- video -> scale -> crop -> fade -> mp4
- svg/graphic -> ffmpeg -> mp4

## P6 Focus: Multi-scene Composition

Compose scene clips into a full render with:

- cuts
- fade
- crossfade
- optional wipes later
- audio synchronization

## P7 Focus: Audio

The long-term timing authority should become narration duration.

```text
script
  -> TTS
  -> voice.wav

voice + music + sfx
  -> final mix
```

Important principle:

```text
narration duration
        ->
visual duration
```

This should eventually be smarter than manually fixed scene durations.

## P8 Focus: Preview And Render UX

The UX should support per-scene choice of:

- existing image
- generate image
- generate video
- graphic

Alongside provider choice, references, motion, and duration.

## P9 Focus: Explainer Production Workflow

Long term, the LLM should act as a director that can draft a scene plan such as:

- hook
- problem
- explanation
- comparison
- payoff

The application then becomes the production studio that turns that plan into deterministic outputs.

## Most Important Architecture Decision

Keep these three things separate:

### 1. Intent

What the video wants to say.

- narration
- concept
- visual intent

### 2. Asset

What material exists or is planned.

- image
- video
- graphic
- audio
- reference

### 3. Rendering

How the scene is made visible.

- zoom
- pan
- crop
- transition
- overlay
- timing

Conceptually:

```text
          WHAT?
           |
      Scene Intent
           |
           v
         ASSET
           |
           v
          HOW?
     Render Settings
           |
           v
         FFmpeg
```

This separation should be preserved even as AI features are added.

## Asset Workflow States

Do not equate AI generation with automatic final asset creation.

Assets should support a workflow such as:

- planned
- generated
- approved
- rejected

Target flow:

```text
LLM makes plan
  -> AI generates candidate assets
  -> user reviews
  -> approve or regenerate
  -> video render
```

## Working Method

This chat acts as the architecture table.

Copilot acts as the build crew.

Recommended execution model:

- do only one brief at a time
- start with P1 next
- for each brief provide a self-contained implementation prompt
- each brief should contain:
  - goal
  - current architecture
  - exact scope
  - data model expectations
  - interfaces
  - UI work
  - tests
  - acceptance criteria
  - explicit not-in-scope list

## Next Recommended Brief

The next implementation brief should be P1: Video Model / Project Schema.

## P10.1 Addendum: Freshness And Dependency Rules

This addendum captures the production execution and freshness rules established by P10.1.

### 1. Production Dependency Flow

The production workflow remains:

Brief
-> Story
-> Scene Plan
-> Scenes
-> Visuals
-> Narration
-> Preview
-> Final Render

Important: workflow order is not the same as universal technical dependency.

Each downstream artifact is invalidated only when one of its actual production inputs changes.

### 2. Narration Freshness

Narration audio has an explicit derived freshness layer.

Relevant inputs include where present:

- narration text
- voice ID
- model
- format
- linked audio asset
- existing generation attempt and asset metadata

Derived narration states are:

- no_narration
- no_audio
- generating
- failed
- current
- stale

Narration edits do not auto-regenerate audio.

Stale audio remains reviewable and replaceable, but it must not silently appear current.

Regeneration remains user-initiated.

### 3. Narration To Composition Dependency

Final composition depends on both visual and narration/audio inputs.

Composition freshness therefore includes:

- scene render identity
- narration/audio identity signature

This is represented by a deterministic composition input fingerprint.

Conceptually:

```text
Scene render
+
Narration audio
  ↓
Composition input fingerprint
  ↓
Final composition
```

If either relevant input changes, the prior composition is no longer current.

### 4. Narration Does Not Auto-Invalidate Scene Renders

Narration changes do not invalidate visual scene renders unless narration/audio is part of those scene render inputs.

Therefore:

```text
Narration changed
  ↓
Narration audio may become stale
  ↓
Composition may become stale
```

But:

```text
Narration changed
  X
  ↓
Scene render does NOT automatically become stale
```

This preserves the split between scene rendering and final composition.

### 5. Optional Narration Audio

Narration text does not universally require generated audio.

A scene can be valid with narration text and no linked audio.

Composition readiness blocks only when audio is linked or expected and that linked asset is missing or invalid.

There is no unconditional rule that every narration must have audio.

### 6. Freshness Is Derived, Not Execution

Freshness means:

the current output may no longer represent the current input.

Freshness does not mean auto-regeneration.

All regeneration remains explicit user action for:

- narration audio
- generated visuals
- generated video
- scene renders
- final composition

### 7. Workflow Integration Rule

Workflow consumes existing freshness and execution signals as derived information.

Workflow must not become a second source of truth.

Canonical sources remain:

- generation state
- narration state
- scene and render state
- composition state
- existing validation and readiness services

Workflow interprets these for guidance and navigation only.

### 8. Architectural Invariant

P10.1 keeps the existing architecture shape:

```text
UI
 ↓
existing API
 ↓
existing service
 ↓
existing provider/job
 ↓
existing domain state
 ↓
derived readiness/freshness
 ↓
workflow UI
```

No separate workflow state machine or orchestration layer is introduced.

## P10.4 Addendum: Production Run Feedback And Diagnostics

This addendum captures the observability layer added for Produce Ready runs.

### 1. Scope And Invariant

P10.4 adds diagnostics visibility for production runs, not a new execution architecture.

The canonical sources of truth remain unchanged:

- generation state
- narration state
- scene render state
- composition state
- derived workflow/readiness services

The run log reports what the runner attempted and observed during this transient run.

### 2. Typed Transient Run Events

Runner events are typed and emitted in execution order.

Each event includes:

- timestamp
- iteration
- event code
- status
- action type when relevant
- scene id when relevant
- human-readable message
- optional sanitized diagnostics payload

### 3. Lifecycle Event Coverage

The runner emits lifecycle and action events including:

- run started
- plan created
- action scheduled
- action started
- action completed
- action failed
- action skipped
- action waiting
- action blocked
- action current
- action running
- video poll scheduled/completed
- refresh started/completed
- composition started/completed/failed
- run completed
- run stopped unresolved
- run failed

### 4. Dependency Diagnostics

Dependency state is surfaced explicitly as events, for example:

- waiting for visual generation
- blocked by renderability/readiness issues
- skipped because output is already current

This allows fast diagnosis of where the production chain is stalled.

### 5. Error Diagnostics

When available, events include existing non-secret error context such as:

- message
- code
- endpoint
- HTTP status
- provider status
- attempt identifier
- details

No API keys, tokens, or full provider payloads are included in the event payload.

### 6. UI Feedback Model

Produce section now provides:

- run state label (running/completed/partial/failed/unresolved)
- compact live activity rows per scene action status
- recent runner event feed
- end-of-run summary counts
- log viewer for full transient run timeline

### 7. Persistence Constraint

P10.4 stays transient:

- no database storage
- no persisted run history
- no new cancellation subsystem

Run events may be cleared by refresh or new run start.
