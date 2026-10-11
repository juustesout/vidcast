# P17 Hermes End-to-End Reconnaissance and Test Plan

Status: RECON ONLY. No application code, dependency, config, or test files were
changed in this phase. All conclusions below are derived from reading the
implementation in this repository (the source of truth). Anything that cannot be
settled by reading code is explicitly marked as "must run to prove".

Objective: decide whether an MCP client (Hermes) can drive an existing local
explainer project end to end using only the tools exposed by the single MCP
server, from project creation through to a valid, playable MP4, and to publish an
executable test plan for that journey.

## 1. Scope and method

- Source of truth: the repository implementation, not the markdown docs. Where a
  doc disagrees with the code, the code wins (discrepancies are listed in
  section 8).
- No paid AI generation was performed. No new tests were added. No commits.
- Local-only target: the Next.js dev server plus the single MCP server. No VPS.
- The MCP server is only an adapter; every capability is backed by an existing
  REST route. Identity, ownership, throttling, and secret handling are enforced
  server-side by the app, never by the MCP layer.

## 2. The single MCP entrypoint

- `package.json` defines `mcp:readonly` and `mcp:local`, both running
  `tsx mcp/read-only/server.ts`.
- `mcp/read-only/server.ts` builds one `McpServer` and registers three tool
  groups in order: read-only, authoring, production. There is exactly one
  server; no second entrypoint exists or should be added.
- Tool count: 6 read-only + 5 authoring + 3 production = 14 tools.

### 2.1 Configuration the server reads

| Env var | Purpose | Default |
| --- | --- | --- |
| `EXPLAINER_API_BASE_URL` | Base URL of the running app API | `http://127.0.0.1:5555` |
| `EXPLAINER_API_TOKEN` | Sent as `Authorization: Bearer <token>` | unset |

- `next dev` serves on port 3000, so a local run must set
  `EXPLAINER_API_BASE_URL=http://127.0.0.1:3000` or every tool will report
  `API_UNAVAILABLE`.
- All three HTTP clients (`mcp/read-only/api-client.ts`,
  `mcp/authoring/api-client.ts`, `mcp/production/api-client.ts`) read the same
  two variables. The read-only client forwards the bearer token
  (`HttpAppApiClient.withAuthHeaders`), so the earlier P14 "read-only tools 401
  against a secured API" gap is closed for the token path.

## 3. End-to-end workflow (tool by tool)

The minimal happy path to a playable MP4, using mock providers and the default
blank-scene materialization, is:

```text
create_project
  -> update_project            (attach explainer story/beats)
  -> plan_scene_intents        (creates DRAFT intents)
  -> update_project            (approve intents: status = approved)   <-- required
  -> materialize_scene_intents (creates blank scenes + narration text)
  -> run_production            (mock; async 202)
  -> get_run_status (poll)     (until run is terminal)
  -> get_run_log               (inspect per-action results)
  -> get_project_compositions  (available + downloadPath)
  -> HTTP GET downloadPath     (fetch MP4 bytes with the same bearer token)
```

### 3.1 create_project

- Tool: `create_project` -> `POST /api/projects`.
- Required args: none (all optional). Accepted: `title`, `description`,
  `durationTarget` (max 600), `aspectRatio` (`16:9|1:1|9:16`), `fps` (max 120).
- Codepath: `app/api/projects/route.ts` -> `projectStore.createProject`.
- Identity: `requireIdentity`. A service caller (bearer token) creates a project
  with no `ownerId`; a user session caller creates one owned by the session
  subject.
- Output: `{ projectId, title, valid: true }` from the MCP tool (the route
  returns the full project with HTTP 201).
- Failure codes: `UNAUTHENTICATED` (401), `INVALID_ARGUMENT` (tool-level Zod),
  `API_UNAVAILABLE` (server down), `API_ERROR` (other).
- Not idempotent: calling twice creates two projects. Use `list_projects` to
  reuse.

### 3.2 update_project (attach the explainer story)

- Tool: `update_project` -> `PUT /api/projects/{id}`.
- Args: `projectId`, `project` (an arbitrary JSON record patch).
- Codepath: `app/api/projects/[id]/route.ts` -> `applyProjectUpdate`
  (`lib/projects/project-update.ts`) -> `normalizeProject`
  (`lib/projects/normalize-project.ts`) -> `validateProject`.
- Merge semantics: the patch is spread over the existing project, then fully
  re-normalized. Passing `explainer` replaces the whole `explainer` object, so a
  partial explainer patch must still carry the fields you want to keep.
- Validation: invalid merged project returns `VALIDATION_FAILED` (422) with
  `details.errors` and `details.warnings`. A non-object body is rejected (the
  tool's schema already requires a record).
- The story beats that drive intent planning live here:
  `explainer.story.beats[]` (each `{ id?, order?, label?, text }`). If no beats
  are provided, `normalizeExplainer` falls back to deriving beats from
  `narration.segments`.

### 3.3 plan_scene_intents

- Tool: `plan_scene_intents` ->
  `POST /api/projects/{id}/scene-intents/plan`.
- Args: `projectId`, optional `project` patch (applied first).
- Codepath: `app/api/projects/[id]/scene-intents/plan/route.ts` ->
  `planSceneIntentsFromBeats` (`lib/explainer/scene-intent-planner.ts`).
- Output: `{ projectId, valid: true, createdIntentIds: string[] }`.
- Important: the planner creates intents with `status: 'draft'`
  (`normalizeIntentStatus` preserves only `'approved'`; the planner does not
  approve). Idempotent: beats that already have an intent are skipped.

### 3.4 Approve the intents (the required intermediate step)

- There is no dedicated "approve" tool. Approval is done with `update_project`
  by sending the explainer with the intents whose `status` is set to
  `'approved'`.
- Because `normalizeExplainer` replaces and re-normalizes the whole
  `sceneIntents` array, the patch must include, for each intent you want to
  approve, at least: `id`, `order`, `beatIds`, and `status: 'approved'`. Other
  fields (`narrativeRole`, `visualIntent`, `narrationDraft`, `timing`,
  `notes`) are defaulted if omitted.
- This is the single biggest friction point in the journey. See section 8
  (discrepancies) and section 9 (proposed improvement). The most practical
  Hermes sequence is: `get_project` -> read `explainer.sceneIntents` -> map each
  to `{...intent, status: 'approved'}` -> `update_project` with the full
  explainer.

### 3.5 materialize_scene_intents

- Tool: `materialize_scene_intents` ->
  `POST /api/projects/{id}/scene-intents/materialize`.
- Args: `projectId`, optional `project` patch, optional explicit `intentIds`
  (max 500). When `intentIds` is omitted, only `approved` intents are
  materialized.
- Codepath: `app/api/projects/[id]/scene-intents/materialize/route.ts` ->
  `materializeSceneIntents` (`lib/explainer/scene-intent-materializer.ts`).
- Materialized scene shape (`createSceneFromIntent`): `type: 'blank'`,
  `visual: { kind: 'blank' }`, `render.transition: { type: 'fade' }`,
  `narration.text = intent.narrationDraft`, `duration = intent.timing.durationSeconds`.
- Output: `{ projectId, valid: true, materialized[], skipped[] }` where entries
  are `{ intentId, sceneId }`. Already-materialized intents land in `skipped`.
- Failure codes (materializer): `INTENT_NOT_FOUND` (404),
  `INTENT_NOT_APPROVED` (422), `INTENT_ALREADY_MATERIALIZED`,
  `INTENT_INVALID_BEAT_REFERENCE` (422), `INTENT_TARGET_SCENE_MISSING` (422).
  The MCP surface maps these through the standard error codes plus
  `VALIDATION_FAILED`.

### 3.6 run_production

- Tool: `run_production` -> `POST /api/projects/{id}/production-runs`.
- Args: `projectId`, `mode` (`mock|real`), `providers{ image: fake|openai,
  video: local|openai, narration: fake|elevenlabs }`, `maxIterations`,
  `limits{ image_generate|video_submit|video_poll|narration_generate|
  scene_render|final_compose }` (each 1..128).
- Codepath: `app/api/projects/[id]/production-runs/route.ts` ->
  `headlessProductionRunService.startOrReuseRun`
  (`lib/production/run-service.ts`).
- Policy: `resolveRunPolicy` (`lib/production/run-policy.ts`). Mock is the
  default when `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is unset; real mode is
  refused with `POLICY_DENIED` (403) unless the flag is true. Mock mode only
  accepts fake/local providers (`PROVIDER_NOT_ALLOWED`, 403 otherwise).
- Server-side authority: a caller may request a provider, never a mode. The
  server config decides mock vs real.
- Behaviour: if an active run already exists for the project, it is returned
  with `reused: true` (HTTP 200); otherwise a new run is created (HTTP 202).
  Runs are executed in-process by the singleton, with debounced persistence to
  `FileRunStore`.
- Output: `{ run: HeadlessRunSnapshot, reused: boolean }`.
- Failure codes: `INVALID_ARGUMENT` (400), `NOT_FOUND` (project, 404),
  `POLICY_DENIED` (403), `PROVIDER_NOT_CONFIGURED` (409), `PRECONDITION_FAILED`
  (409).

### 3.7 get_run_status / get_run_log

- `get_run_status` -> `GET /api/production-runs/{runId}`. Ownership is enforced
  through the run's project (`requireProjectAccess`), so an unknown run and
  another user's run both surface as NOT_FOUND (no existence leak). Throttled
  under the `run_status` bucket.
- `get_run_log` -> `GET /api/production-runs/{runId}/log`, paginated with
  `cursor` and `limit` (max 2000). Throttled under `run_log`.
- Poll `get_run_status` until `run.status` is terminal (`completed` or
  `failed`). The snapshot carries `status`, `summary`
  (`completed/failed/running/waiting`), `completedActionIds`,
  `failedActionIds`, and `unresolvedActions`.

### 3.8 get_project_compositions and the download

- `get_project_compositions` reads `GET /api/projects/{id}` and projects the
  `compositions[]` array. Output: `{ projectId, available, latest,
  compositions[] }` where each entry is `{ compositionId, createdAt, duration,
  width, height, fps, sceneCount, filesize, downloadPath }`, sorted newest
  first. Optional `compositionId` filter raises `NOT_FOUND` when absent.
- `downloadPath` = `/api/projects/{id}/compositions/{compositionId}/file`.
- The tool never returns MP4 bytes. Hermes performs an authenticated
  `GET {baseUrl}{downloadPath}` with the same bearer token to fetch the MP4.
- Download route (`app/api/projects/[id]/compositions/[compositionId]/file/route.ts`):
  guards against absolute paths and `..` traversal, verifies the path stays
  under the project root, calls `requireProjectAccess`, and serves
  `video/mp4`. Missing file -> 404; missing composition -> 404.

## 4. What mock mode actually fakes

This is the most important non-obvious finding for the test plan.

- Mock mode replaces the AI providers: image = `fake`, video = `local`,
  narration = `fake`, music = `fake` (`resolveProviderDefaults`).
- Fake image provider (`lib/ai/image-generation/fake-provider.ts`): deterministic
  1280x720 PNG generated with `sharp`, no network.
- Fake narration provider (`lib/ai/text-to-speech/fake-provider.ts`): silent WAV
  (base64), duration 0.25s, no network.
- Mock mode does NOT fake rendering or composition. `scene_render` and
  `final_compose` always call `LocalFFmpegRenderer` / the video compositor,
  which shell out to `ffmpeg`/`ffprobe` (`lib/render/ffmpeg-runtime.ts`, env
  `FFMPEG_PATH`/`FFPROBE_PATH`, default `ffmpeg`/`ffprobe`).
- Therefore mock mode still requires a working local FFmpeg. Without it,
  scene_render and final_compose throw `FFMPEG_UNAVAILABLE` (mapped to 503 in
  the run's per-action error). In this environment `ffmpeg`/`ffprobe` are not on
  PATH (verified), so a full mock run cannot produce an MP4 here until FFmpeg is
  installed. Classify this as an environment gap, not a product defect.

### 4.1 Why blank scenes are enough for a playable MP4

- The materializer produces blank scenes, and `resolveRenderPlan`
  (`lib/render/scene-resolver.ts`) treats `visual.kind === 'blank'` as
  `renderable` with `source: { kind: 'blank' }`. The renderer draws the project
  background for the scene duration.
- Consequence: the happy path does NOT require `image_generate` at all. The
  planner (`lib/production/production-planner.ts`) only emits `image_generate`
  for `visual.kind === 'generated_image'`; blank scenes emit only
  `narration_generate` + `scene_render`. So the mock run's required action set
  is `narration_generate`, `scene_render`, `final_compose`.
- To exercise the image path (and thus the fake image provider), Hermes must
  first set a scene's visual to `generated_image` with a non-empty
  `generation.prompt` (otherwise the planner marks the action `blocked`
  "Generation prompt is required.").

## 5. Auth, ownership, throttling, secrets

- `lib/security/auth.ts` accepts either a signed session cookie
  (`explainer_session`) or `Authorization: Bearer <EXPLAINER_API_TOKEN>`.
- `requireIdentity` throws `UNAUTHENTICATED` (401) when neither is present.
- `requireProjectAccess` (`lib/security/access-control.ts`): service identity
  bypasses owner checks. A user identity may claim a legacy ownerless project
  (default `claimLegacyOwner: true`); mismatched ownership returns NOT_FOUND
  (404) to avoid leaking existence.
- Anonymous sessions are only minted in non-production with
  `EXPLAINER_SECURITY_MODE=local` (`isAnonymousSessionAllowed`,
  `lib/security/config.ts`). In production, a caller must supply the bearer
  token or a real session.
- Throttling buckets relevant to the journey: `run_start` (default 6/min),
  `run_status` (120/min), `run_log` (120/min), `render_scene` (10/min),
  `compose_project` (8/min), `generate_narration` (20/min),
  `generate_image` (20/min). Exceeding a bucket returns `RATE_LIMITED` (429)
  with `retryAfterSec`.
- Secrets: the MCP layer forwards `EXPLAINER_API_TOKEN` and never returns it.
  Provider keys (`OPENAI_API_KEY`, `ELEVENLABS_API_KEY`) stay server-side; the
  preflight only checks presence, never returns values.

## 6. Failure and recovery model

- Run persistence: `FileRunStore` persists run snapshots; on process restart
  `recoverRuns` rehydrates and resumes non-terminal runs
  (`lib/production/run-service.ts`).
- `reconcileInterruptedGenerations` (`lib/production/run-recovery.ts`) fixes
  interrupted generation state: a video attempt with a provider job id is
  resumed by polling; an active attempt with a usable persisted asset is
  restored to `generated`; otherwise it is marked `failed`. In real mode, an
  unrecoverable interrupted attempt is suppressed by action id so it is not
  silently re-billed.
- Idempotency: `run_production` reuses an active run per project. The
  materializer reports already-materialized intents as `skipped`. The planner
  skips beats that already have intents. Render/compose write new artifacts
  (new renderId/compositionId) rather than mutating prior ones.

## 7. Test plan

### 7.1 Local primary (mock providers, real FFmpeg)

Prerequisites:
- Local FFmpeg/ffprobe on PATH (or `FFMPEG_PATH`/`FFPROBE_PATH` set).
- App running (`npm run dev`, port 3000).
- `EXPLAINER_API_BASE_URL=http://127.0.0.1:3000`.
- `EXPLAINER_API_TOKEN` set to a strong (>= 32 char) value and matching between
  app and MCP process, OR a local anonymous session.

Journey (happy path, blank scenes):

| # | Action | Expected | Proves |
| --- | --- | --- | --- |
| 1 | `create_project {title}` | `valid: true`, `projectId` | create + auth |
| 2 | `update_project` with a small explainer (`story.beats[]` 2-3 beats, `brief`, `story.script`) | `valid: true` | update + normalization + validation |
| 3 | `plan_scene_intents {projectId}` | `createdIntentIds.length >= 1` | planner |
| 4 | `get_project` then `update_project` approving the intents (`status: 'approved'`) | `valid: true` | approval path |
| 5 | `materialize_scene_intents {projectId}` | `materialized.length >= 1` | materializer + blank scene creation |
| 6 | `run_production {projectId, mode:'mock', providers:{image:'fake',video:'local',narration:'fake'}}` | run snapshot, `reused: false` | run start + policy |
| 7 | poll `get_run_status {runId}` until terminal | `status: 'completed'`, no failed action ids | runner + fake narration + real render/compose |
| 8 | `get_run_log {runId}` | events include scene_render + final_compose success | per-action tracing |
| 9 | `get_project_compositions {projectId}` | `available: true`, `latest.downloadPath` present | composition persisted |
| 10 | HTTP GET `downloadPath` with bearer token | 200, `Content-Type: video/mp4`, non-zero bytes | artifact retrieval |
| 11 | Validate MP4 | decodes; dimensions match `renderSettings`; duration > 0 | playable output |

Variations:
- Image path: set one scene to `generated_image` with a prompt before
  `run_production`; expect an `image_generate` action using the fake provider,
  then a rendered scene using the generated PNG.
- No narration: empty `narrationDraft` -> `narration_generate` blocked, but the
  run can still render/compose a silent video (verify this is the intended
  behaviour when executing).
- Idempotency: call `run_production` twice; second call returns `reused: true`.
- Negative/security: omit the token -> 401; call with a foreign-owned project ->
  404; invalid provider in mock mode -> 403.

### 7.2 What can be proven by reading vs must be executed

Proven by code reading:
- Tool inventory, schemas, required args, and error-code mapping.
- The draft-vs-approved intent blocker and the approval workaround.
- Blank scenes are renderable; the happy path needs no images.
- Mock mode still requires local FFmpeg; download route guards are present.

Must run to prove:
- The full mock run actually reaches `completed` and yields a decodable MP4
  (blocked here only by the missing FFmpeg binary).
- Exact wall-clock timing and whether default throttles are hit for larger
  projects.
- Real-provider behaviour (needs credentials + the allow flag; explicitly out
  of scope for this phase).

### 7.3 Cloud/real mode (optional, not run)

- Real mode requires `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS=true`,
  `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, and a valid `EXPLAINER_API_TOKEN`.
  `assertRunPolicyPreflight` only checks presence of the keys.
- Cloud FFmpeg availability is a deployment concern; missing it yields
  `FFMPEG_UNAVAILABLE` (503). Treat as environment, not product.
- No paid calls are part of this test plan.

## 8. Blockers, risks, and discrepancies

P0 blockers:
- No dedicated intent-approval tool: the happy path between `plan_scene_intents`
  and `materialize_scene_intents` requires a full-explainer `update_project`
  round trip. It works, but it is error-prone and undocumented as a required
  step.
- Local FFmpeg is mandatory even in mock mode. In this environment it is absent,
  so no MP4 can be produced until installed. This blocks the final two steps of
  the E2E for now.

P1 risks:
- `update_project` replaces the entire `explainer` object; a partial patch can
  silently drop `sceneIntents`/`beats`. Callers must send complete structures.
- The planner emits `image_generate` only for `generated_image` scenes. Agents
  expecting images from blank/materialized scenes will see none.
- Throttle defaults are in-memory and per subject; a burst of `run_start`
  (6/min) could surprise an automated driver.
- `get_run_status`/`get_run_log` do not re-check that the run's project still
  exists beyond what `requireProjectAccess` does at request time; long-lived
  polling after project deletion will surface NOT_FOUND.

P2 notes/discrepancies vs docs:
- `docs/p16-mcp-authoring.md` and `p16-mcp-authoring-report.md` document the
  base URL default `5555` and note the need to override for `next dev` (3000);
  the code matches. Ensure the test harness sets it.
- The authoring `run_production` schema does not include a `music` provider
  (harmless; music is managed separately via `manage_project_music`), while
  server-side `RunProviderSelection` does include `music`. Not a bug, but worth
  noting for completeness.
- The materializer's approval requirement is by design but is not called out as
  a required step in the tool descriptions.

## 9. Next-phase proposal (out of scope for P17)

Options, to be chosen by the owner:
1. Add an explicit approval affordance: either a dedicated `approve_scene_intents`
   tool/route, or teach `materialize_scene_intents` to accept an
   `approve: true` flag (server-side). Reduces the E2E to one fewer fragile
   step.
2. Add a convenience `plan_and_materialize` path that plans, approves all
   freshly created intents, and materializes in one call for the common case.
3. Provide a small helper tool `download_composition` that streams the MP4 to a
   caller-provided local path, so the agent does not have to construct the
   authenticated GET itself.
4. Document the exact approval payload shape in the authoring tool descriptions.

## 10. Prioritized recommendations

- P0: Ensure FFmpeg/ffprobe are available in any environment expected to render
  (including mock E2E). Without it, step 9/10/11 of the test plan cannot pass.
- P0: Document, in the tool descriptions and in `docs/p16-mcp-authoring.md`, that
  intents must be approved (via `update_project`) before materialization.
- P1: Add the intent-approval affordance (option 1 or 2 above) to remove the
  manual full-explainer round trip.
- P1: Make `update_project` merge semantics safer, or clearly document the
  replace-the-whole-explainer behaviour.
- P2: Add a `download_composition` convenience tool.
- P2: Reconcile the `music` provider discrepancy between tool schema and server
  policy types.

## 11. Open questions

- Is a silent video (no narration audio) an acceptable successful output, or
  should `final_compose` require narration? Decide before writing assertions.
- Should the E2E assertion require at least one `image_generate` action (thus a
  generated image), or is the blank-scene render sufficient as the canonical
  happy path?
- Should mock mode ever be allowed to skip FFmpeg (e.g., emit a pre-baked
  placeholder MP4) for CI environments without FFmpeg? This is a product
  decision, not a recon conclusion.

## 12. References (key files)

- MCP entrypoint: `mcp/read-only/server.ts`; clients `mcp/read-only/api-client.ts`,
  `mcp/authoring/api-client.ts`, `mcp/production/api-client.ts`.
- Tools: `mcp/read-only/tools.ts`, `mcp/authoring/tools.ts`,
  `mcp/production/tools.ts`.
- REST: `app/api/projects/route.ts`, `app/api/projects/[id]/route.ts`,
  `app/api/projects/[id]/scene-intents/{plan,materialize}/route.ts`,
  `app/api/projects/[id]/production-runs/route.ts`,
  `app/api/production-runs/[runId]/{route,log/route}.ts`,
  `app/api/projects/[id]/compositions/[compositionId]/file/route.ts`.
- Domain: `lib/explainer/scene-intent-{planner,materializer}.ts`,
  `lib/production/{production-planner,run-policy,run-service,run-recovery}.ts`,
  `lib/render/{scene-resolver,scene-render-service,video-composition-service,ffmpeg-runtime}.ts`,
  `lib/ai/{image-generation/fake-provider,text-to-speech/fake-provider}.ts`,
  `lib/security/{access-control,auth,config}.ts`.
