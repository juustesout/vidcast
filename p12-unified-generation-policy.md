# P12 - Unified Generation Policy

## Objective

Every image, video, and narration generation path now resolves its provider
through one server-side policy. Paid providers (OpenAI, ElevenLabs) can only
run after an explicit server opt-in plus present credentials. There is no
silent fallback between fake/local and real providers.

## Single source of truth

All provider gating lives in `lib/production/run-policy.ts`, extending the
existing headless-run policy rather than adding a second system:

- `resolveRunPolicyServerConfig()` reads `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS`
  (default `false`) and `PRODUCTION_RUN_DEFAULT_MODE` (default `mock`). When
  real providers are not allowed, the effective default mode is forced to
  `mock`.
- `resolveProviderDefaults(mode)` is now exported so registries can report the
  policy default instead of hard-coding OpenAI.
- `resolveManualGenerationProvider(kind, requestedProvider, options)` is the
  new shared resolver for interactive/manual generation calls. It:
  1. Reads the server config (authority for mock vs. real).
  2. Normalizes the requested provider per modality (`local`/`fake` aliases,
     unknown values rejected with `INVALID_POLICY`).
  3. Builds only the requested modality into the policy request and calls
     `resolveRunPolicy`.
  4. Asserts credentials when the resolved mode is `real`.
  It ignores any client-supplied mode; only the server config plus an explicit
  internal `mode` override (used by locked headless runs) affect the result.

## Behavior matrix

| Server config | Requested provider | Result |
| --- | --- | --- |
| mock | none | fake (image/narration), local (video) |
| mock | openai / elevenlabs | rejected `PROVIDER_NOT_ALLOWED` (403) before any request is built |
| mock | fake / local | accepted fake/local |
| real | none | openai (image/video), elevenlabs (narration) |
| real | openai / elevenlabs | accepted only with `OPENAI_API_KEY` / `ELEVENLABS_API_KEY`, else `PROVIDER_NOT_CONFIGURED` (409) |
| real | fake / local | rejected `PROVIDER_NOT_ALLOWED` (403) |
| any | gemini / other / unknown | rejected `INVALID_POLICY` (400) |

## Wiring

- `lib/generation/image-generation-service.ts` no longer uses
  `options.provider || current.provider || 'openai'`. It resolves through
  `resolveManualGenerationProvider('image', options.provider, { mode })` after
  scene validation and before any attempt is queued.
- `lib/generation/video-generation-service.ts` submit drops
  `VIDEO_GENERATION_DEFAULT_PROVIDER || 'openai'` and resolves through the same
  helper. The poll path (`refreshVideoGenerationAttempt`) also resolves the
  attempt's provider through the policy before calling `getStatus`, so a mock
  server cannot poll an in-flight OpenAI job.
- `lib/generation/narration-service.ts` removes `resolveDefaultProvider()`
  (which selected ElevenLabs whenever `ELEVENLABS_API_KEY` existed) and
  resolves through the policy. An idle key alone can no longer trigger
  ElevenLabs.
- `lib/production/run-service.ts` passes its locked `policy.mode` into every
  generation call (`generateImage`, `submitVideo`, `pollVideo`,
  `generateNarration`) so a headless real run is not rejected by the manual
  server default.
- Each service maps `RunPolicyError` into its own typed error
  (`generation.policy.denied`, `generation.provider.notAllowed`,
  `generation.provider.notConfigured`, `generation.policy.invalid`,
  `narration.*`) so existing route catch blocks keep returning JSON.

## Registries and UI

- `getImageGenerationConfigurationStatus`, `getVideoGenerationConfigurationStatus`,
  and `getTextToSpeechConfigurationStatus` now report the policy default
  (`fake` / `local` / `fake` in mock) instead of `openai`.
- `components/project/project-workspace.tsx` new-scene defaults and the
  provider dropdown fallback use `local` instead of `openai`, so mock mode no
  longer advertises or pre-selects a paid provider.

## Explicitly out of scope

No Gemini, persistence, FFmpeg, auth, music/subtitles, LLM scripts, public
deploy, or secrets were added. Headless run snapshots, authorization,
throttling, async video jobs, and MCP paths are unchanged and inherit the
policy automatically.

## Scene-record providers

A scene's stored `generation.provider` is display/legacy metadata and is not
used for execution. Execution uses only an explicit request provider plus the
server policy, so legacy scenes carrying `provider: 'openai'` cannot force a
paid call in mock mode.

## Verification

- `npx tsc --noEmit`: clean.
- `npm run lint`: clean.
- Focused suites (run-policy, image/video/narration services, all three
  registries, production-run-service): 36 passed.
- Full suite: 189 passed, 2 failed. The 2 failures are the pre-existing
  `local-ffmpeg-renderer` and `fake-image-provider-render` tests, which require
  `ffmpeg`; `ffmpeg` is not installed in this environment. No paid APIs were
  called; all adapters were mocked or fake.

## Environment note

`npm ci` failed because the committed lockfile was out of sync with
`package.json` (missing `@emnapi/*` entries). `npm install` was used to install
dependencies for verification, which updated `package-lock.json`. That lockfile
change is a side effect of dependency installation, not part of the policy
logic.
