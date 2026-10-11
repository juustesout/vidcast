# Project Baseline Reconnaissance

Date of inspection: 2026-10-09.
Scope: repository facts on the current checkout. No application source or configuration was modified. Dependencies were not installed. Real providers were not invoked.

Distinction used below:

- **Verified:** observed in this checkout (files, functions, git state, local environment).
- **Reported historical:** claimed in prior phase docs; not re-executed here.
- **Outstanding runtime:** cannot be proven without installing packages, starting the app, or inspecting a real deployment.

---

## 1. Repository identity

| Item | Value |
|---|---|
| Package name | `local-explainer-video-studio` (`package.json`) |
| Branch | `main` |
| HEAD | `1b4730ba690835e33c359697095a00c57d7517fc` |
| HEAD message | `Initial commit` (2026-10-09, Juust Out) |
| Working tree | clean (`git status --porcelain` empty) |
| User changes | none present |
| Submodules | none (no `.gitmodules`) |
| README | none |
| `.env` / `.env.example` | none |
| Docker / CI / GitHub workflows | none |

The entire application arrived as a single commit. Prior phase reports exist in-repo (`docs/`, `p11.6-security-boundary-deployment-recon.md`, `p11.7-api-security-implementation.md`) and describe multi-phase work that is already in this tree.

Tracked tree notes (not dirty, but unusual):

- `.next/` is committed (406 tracked files). `.gitignore` only ignores `.env`, `/node_modules/`, `/projects/`.
- `tmp-fake.mp4` and `tmp-fake.png` are tracked.
- `tsconfig.tsbuildinfo` is tracked.
- `node_modules/` is absent in this checkout.
- `projects/` is absent (gitignored; no seeded on-disk project until first store access).

Do not discard or overwrite this tree. There is no uncommitted user work to preserve, but the committed `.next` and tmp artifacts should be left alone unless a later cleanup phase is explicitly requested.

---

## 2. Actual architecture

Next.js 15 App Router application. TypeScript. Vitest. Local filesystem persistence. No extra process/service layer.

```text
UI (app/, components/)
  -> API routes (app/api/)
    -> domain services (lib/generation, lib/render, lib/production, lib/explainer)
      -> provider adapters (lib/ai/*)
      -> filesystem store (lib/storage)
MCP stdio (mcp/) -> HTTP client -> same API
```

### Major directories

| Path | Role |
|---|---|
| `app/` | Pages (`/`, `/projects`, `/projects/[id]`) and API routes |
| `components/` | Project workspace, story, workflow, server-run panel, preview, UI primitives |
| `lib/types/` | Domain models: project, scene, asset, reference, generation, render, explainer |
| `lib/storage/` | `project.json` + assets/references/renders/previews under `projects/<id>/` |
| `lib/ai/` | Image, video, TTS provider interfaces, fake adapters, OpenAI/ElevenLabs adapters |
| `lib/generation/` | Scene image/video/narration services, freshness, generation-state transitions |
| `lib/render/` | FFmpeg scene renderer, composition, fingerprints, status derivation |
| `lib/production/` | Planner, runner, run policy, in-memory run registry, run service |
| `lib/explainer/` | Scene-intent planner and materializer |
| `lib/security/` | Session/service identity, ownership, throttle |
| `lib/workflow/` | Derived workflow step status and navigation |
| `mcp/read-only/` | Stdio MCP server + read-only tools |
| `mcp/production/` | Production run tools registered on the same server |
| `tests/` | 42 Vitest files |
| `docs/` | Blueprint and P11.* reports |
| `scripts/` | MCP/credential harnesses |

### Entry points

- Web: `app/page.tsx`, `app/projects/page.tsx`, `app/projects/[id]/page.tsx` -> `components/project/project-workspace.tsx`
- API: `app/api/**/route.ts` (no Next middleware file)
- MCP: `mcp/read-only/server.ts` (`npm run mcp:readonly` / `mcp:local`)
- Scripts: `package.json` `dev`/`build`/`start`/`lint`/`typecheck`/`test`/`test:mcp`

### Domain model (verified)

`Project` in `lib/types/render.ts`: `id`, optional `ownerId`, title/description, duration/aspect/fps, `explainer?`, legacy `narration`, `scenes`, `assets`, `references`, `renderSettings`, `compositions?`.

`Scene` in `lib/types/scene.ts`: order, duration, `source` (intent/beat trace), type, narration spec, visual spec (asset / generated image / generated video / graphic / text / blank), render motion/transition, overlay, referenceIds, notes, render artifacts.

`ExplainerSpec` in `lib/types/explainer.ts`: brief, story (script/beats/versions), `sceneIntents` (beatIds, narrativeRole, visualIntent, narrationDraft, timing, status, materializedSceneId).

Assets and references are first-class records with provenance and on-disk paths (`lib/types/asset.ts`, `lib/types/reference.ts`).

### Persistence

- Root: `projects/` via `lib/storage/storage-paths.ts` (`process.cwd()`).
- Store: `lib/storage/project-store.ts` (`JsonProjectStore`) writes `project.json`, reconciles missing assets, seeds a sample project on first list/get.
- Media: `lib/storage/media-store.ts` (imported by store and generation services).
- Production runs are **not** persisted. `InMemoryRunRegistry` in `lib/production/run-registry.ts` is process-local with retention sweep.

### Provider interfaces

- Image: `lib/ai/image-generation/provider.ts` + registry (`openai`, `fake`).
- Video: `lib/ai/video-generation/provider.ts` + registry (`openai`, `fake`/`local`). Async submit/poll/download.
- TTS: `lib/ai/text-to-speech/provider.ts` + registry (`elevenlabs`, `fake`/`local`).
- Gemini appears in `GenerationProvider` union and sample data only. No Gemini adapter.
- `ScriptGenerator` in `lib/types/ai.ts` is an unused interface. No LLM planner adapter.

### Orchestration

- Planner: `deriveProductionPlan()` in `lib/production/production-planner.ts` (image_generate, video_submit, video_poll, narration_generate, scene_render, final_compose).
- Browser runner: `runProductionBatch()` called from `project-workspace.tsx` (`runProduceReady`).
- Server runner: `HeadlessProductionRunService` in `lib/production/run-service.ts`, started by `POST /api/projects/[id]/production-runs`.
- UI tracker: `components/project/server-run-panel.tsx` + `lib/client/production-run-client.ts` / `production-run-tracker.ts`.

---

## 3. Verified phase status

Historical reports claimed 184 tests / 42 files plus passing typecheck, lint, and build. That is **reported historical**, not re-verified here. File counts match (42 test files). Commands were not run because `node_modules` is missing and this task forbids installing dependencies.

| Phase | Status | Evidence |
|---|---|---|
| P0 Foundation | Implemented | Next app, layout, home/project pages, Tailwind |
| P1 Video model / scenes | Implemented | `lib/types/scene.ts`, `lib/types/render.ts`, `tests/p2-domain.test.ts` |
| P2 Assets and references | Implemented | `lib/storage/project-store.ts`, asset/reference API routes, `components/references/reference-browser.tsx` |
| P3 Image providers | Implemented (OpenAI + fake; no Gemini) | `lib/ai/image-generation/*`, `lib/generation/image-generation-service.ts` |
| P4 Async video jobs | Implemented (OpenAI + fake/local) | `submitSceneVideoGeneration` / `refreshVideoGenerationAttempt` in `lib/generation/video-generation-service.ts`; `GET .../generation-jobs/[attemptId]` |
| P5 Local FFmpeg scene render | Implemented in code | `lib/render/renderer.ts`, `scene-render-service.ts`; **FFmpeg not in PATH in this environment** |
| P6 Composition | Implemented | `lib/render/video-composition-service.ts`, `video-compositor.ts` (`COMPOSER_VERSION = 'p7'`), integration tests present |
| P7 Audio / TTS | Partial | Narration TTS + freshness + composition mux: yes. Music/SFX mix: no. Timed subtitles: flag only |
| P8 Preview + render UX | Partial | CSS motion preview (`components/preview/scene-preview.tsx`), per-scene generate/render controls, generation tab. Home copy still says "FFmpeg later" |
| P9 Scene intent | Implemented as structured workflow, not LLM director | `lib/explainer/scene-intent-planner.ts`, `scene-intent-materializer.ts`, story workspace, workflow status. Materializer creates `visual.kind: 'blank'` scenes |
| P10.1 Freshness | Implemented | `lib/generation/narration-freshness.ts`, composition input fingerprint in `lib/types/render.ts` |
| P11.1 Read-only MCP | Implemented | `mcp/read-only/{server,tools,api-client}.ts`; tools: list/get project, get scene, validation report, production plan |
| P11.3 Headless runner | Implemented | `lib/production/run-service.ts` lifecycle queued/running/completed/partial/failed/unresolved; dedupe by active project; concurrency/iteration/action/poll limits |
| P11.4 MCP production tools | Implemented | `mcp/production/tools.ts`: `run_production`, `get_run_status`, `get_run_log`; bearer forwarding in production HTTP client only |
| P11.5 Server-run UI | Implemented | `components/project/server-run-panel.tsx`; browser runner retained |
| P11.7 API security | Implemented on API routes | `lib/security/{auth,access-control,http-response}.ts`; ownership; per-identity throttle. **Not** applied to RSC pages or home server actions. **Not** declared public-safe in `p11.7-api-security-implementation.md` |

P7 details:

- Implemented: `generateSceneNarration()` (`lib/generation/narration-service.ts`), ElevenLabs fail-closed without `ELEVENLABS_API_KEY`, fake TTS, narration attempt history, freshness states (`no_narration` / `no_audio` / `generating` / `failed` / `current` / `stale`), composition uses narration as the scene audio track (`buildNormalizeArgs` in `lib/render/video-compositor.ts`).
- Missing: background music mix, SFX, burn-in/sidecar subtitles despite `renderSettings.subtitlesEnabled`, narration-duration as timing authority (scene duration remains manual; intent timing copies a default 5s).

P9 details:

- Fields match the brief: beatIds, narrativeRole, visualIntent, narrationDraft, timing, status, materializedSceneId, scene.source trace.
- Planner is deterministic beat-to-intent (`planSceneIntentsFromBeats`), not an LLM.
- Materialized scenes are blank until the user/production run assigns visuals.

---

## 4. End-to-end execution flow

Intended path, with what actually happens:

1. **Create/open project**
   - API: `POST /api/projects` assigns `ownerId` for user sessions.
   - Home page server action `projectStore.createProject()` in `app/page.tsx` creates an **unowned** project with no session.
   - RSC `app/projects/[id]/page.tsx` loads any project by id with no authz.

2. **Brief / story / scene intents**
   - Edited in `ExplainerStoryWorkspace`.
   - `POST .../scene-intents/plan` -> `planSceneIntentsFromBeats()`.
   - `POST .../scene-intents/materialize` -> `materializeSceneIntents()` creates blank scenes with narration draft and source trace.
   - Missing link: no LLM script/beat generation. Story is manual.

3. **Scene visuals**
   - User sets visual kind and prompt in the workspace (default provider `'openai'` in `defaultScene()`).
   - Manual: `POST .../scenes/[sceneId]/generate-image` or `generate-video`.
   - Image default: `options.provider || current.provider || 'openai'` in `generateSceneImage()`.
   - Video default: `options.provider || current.provider || VIDEO_GENERATION_DEFAULT_PROVIDER || 'openai'` in `submitSceneVideoGeneration()`.
   - Manual routes do **not** pass a provider and do **not** run `assertRunPolicyPreflight`.
   - Missing link: Gemini advertised in UI constants but not executable.

4. **Narration audio**
   - Manual: `POST .../generate-narration`.
   - Default provider: `TTS_DEFAULT_PROVIDER` or ElevenLabs if `ELEVENLABS_API_KEY` is set, else fake (`resolveDefaultProvider()`).
   - Stale audio does not auto-regenerate (verified in freshness module and planner).

5. **Scene render**
   - `sceneRenderService.renderScene()` -> `LocalFFmpegRenderer` (`lib/render/renderer.ts`).
   - Deterministic motion via zoompan/filters. Independent of AI providers.
   - Blocker in this environment: `ffmpeg` not on PATH.

6. **Compose**
   - `videoCompositionService.composeProject()` concatenates scene MP4s, muxes narration or silence, optional fade.
   - Fingerprint includes scene render ids + narration signature.
   - No music bed, no subtitle burn-in.

7. **Production run**
   - Server: policy snapshot locked in `acceptedConfig`; executes planner actions with explicit providers.
   - Browser: `runProduceReady()` calls the same planner but hits HTTP routes without locking mock/real policy.
   - Runs are not durable across process restart (`getRun` 404 message states this).

Missing links (workflow, not just polish):

- LLM director / script generation (`ScriptGenerator` unused).
- Intent materialization does not create generation-ready visuals (blank scenes).
- Manual generation path is not bound to production-run policy.
- Music/SFX/subtitles.
- Persistent run registry / resume after restart.
- Home/RSC paths bypass the API security boundary.
- Read-only MCP client does not send `EXPLAINER_API_TOKEN` (`mcp/read-only/api-client.ts`), so those tools 401 against a secured API unless something else injects cookies.

---

## 5. Provider and cost controls

### Selection

| Path | How provider is chosen | Fail-closed? |
|---|---|---|
| Headless production run | `resolveRunPolicy()` + `assertRunPolicyPreflight()` in `lib/production/run-policy.ts`. Default mode `mock` unless `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` is true. Mock allows only `fake`/`local`/`fake`. Real requires openai+openai+elevenlabs and env keys | Yes for runs |
| Server run executeAction | Passes locked `providers.image/video/narration` into generation services (`run-service.ts`) | Yes |
| Manual generate-image route | No provider in body; service defaults to **openai** | Provider adapter fails if key missing (409), but intent is paid-provider-first |
| Manual generate-video route | Same; default **openai** | Same |
| Manual generate-narration | Body may include `provider`; else ElevenLabs if key present | ElevenLabs throws `NOT_CONFIGURED` without key |
| Browser batch runner | Calls the manual HTTP routes | Inherits manual defaults |

### Credential checks

- OpenAI image: `OpenAiImageGenerationProvider.generateImage()` throws if `OPENAI_API_KEY` missing (`lib/ai/image-generation/openai-provider.ts`).
- OpenAI video: same for `OPENAI_API_KEY` (`lib/ai/video-generation/openai-provider.ts`).
- ElevenLabs: `ELEVENLABS_API_KEY` (`lib/ai/text-to-speech/elevenlabs-provider.ts`).
- Run preflight additionally requires those env vars **before** queueing a real run when the plan needs visual/narration generation.

### Accidental paid-call prevention

What works:

- `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` defaults false (`envBool(..., false)`).
- Mock mode rejects real providers.
- Real mode rejects fake/local mix.
- No silent mock fallback when real is requested.
- Fake image provider produces deterministic PNG via `sharp` (no network).

What does not work as a studio-wide cost fence:

- UI and new scenes default `provider: 'openai'`.
- Manual image/video generation defaults to openai even in a mock-oriented server.
- Status route `GET /api/image-generation/status` is unauthenticated and reports whether OpenAI is configured (`getImageGenerationConfigurationStatus()`), defaultProvider `'openai'`.
- Presence of `ELEVENLABS_API_KEY` switches default TTS to paid without an explicit run-mode flag.
- No spend ledger, per-project budget, or dry-run estimate.

This recon did not read or print any secret values. No `.env` file exists in the checkout.

---

## 6. Security posture

Implemented (API):

- Identity: signed cookie `explainer_session` or `Authorization: Bearer EXPLAINER_API_TOKEN` (`lib/security/auth.ts`).
- `requireProjectAccess()`: user must own `project.ownerId`; missing owner is first-claimed; foreign project returns 404; service token bypasses ownership (`lib/security/access-control.ts`).
- Throttle buckets for run start/status/log, generate image/video/narration, video poll, render, compose. In-memory, per process, keyed by identity subject.
- Production MCP client forwards bearer when `EXPLAINER_API_TOKEN` is set (`mcp/production/api-client.ts`).
- Run log sanitizes `Bearer ...` and `sk-...` (`sanitizeText` in `run-registry.ts`).
- File routes check path safety under project root.

Unresolved / high risk:

1. **Anonymous session minting.** `POST /api/auth/session` issues a new user identity to anyone with no cookie. Workspace bootstraps this on mount (`project-workspace.tsx`). This is local-dev convenience, not authentication.
2. **Default session HMAC secret.** `EXPLAINER_SESSION_SECRET` falls back to `'explainer-local-dev-session-secret'` (`getSessionSecret()`). Forged cookies are trivial if the default is used.
3. **RSC / server actions are outside the API gate.** `app/page.tsx` lists all projects and creates unowned projects. `app/projects/[id]/page.tsx` serves any project JSON into the client.
4. **Service token is a global superuser** (`subject: 'service:api_token'`). One shared secret, no per-caller isolation. Comparison is not timing-safe (plain `===`).
5. **Read-only MCP has no auth header.** After P11.7, those tools cannot call a locked API without extra wiring.
6. **No middleware, CORS, CSRF, or security headers** (`next.config.mjs` is only `reactStrictMode`).
7. **Throttle is not cluster-safe** and resets on restart.
8. **GET video poll mutates state** (provider poll, download, project write) — now authed+throttled, but still a GET with side effects.
9. **No deployment boundary in-repo.** No Docker, bind-address pin, or reverse-proxy config. Next `dev`/`start` defaults apply.
10. **Not public-safe.** `p11.7-api-security-implementation.md` already concludes this. That conclusion still holds.

Protected route family (API): all `/api/projects*` and `/api/production-runs*` inspected routes call `requireIdentity` or `requireProjectAccess`. Unprotected: `/api/health`, `/api/auth/session`, `/api/image-generation/status`.

---

## 7. Verification baseline

Available scripts (`package.json`):

```text
dev, build, start, lint, typecheck, test, test:mcp, test:mcp:readonly, mcp:readonly, mcp:local
```

Test runner: Vitest (`vitest.config.ts`, Node environment, `@` alias). 42 test files covering domain, providers, generation, render/composition, planner/runner/policy/registry, MCP, security, workflow, and some React components.

Checks actually performed in this session:

| Check | Result |
|---|---|
| Git identity / dirty state | Verified: `main` @ `1b4730b`, clean |
| Submodules | None |
| `node_modules` | Absent — tests/lint/typecheck/build **not run** |
| `ffmpeg` | Not in PATH |
| Node / npm | Node v22.22.0, npm 10.9.4 |
| `.env*` | None |
| Paid provider calls | Not invoked |
| Historical 184 tests / typecheck / lint / build | **Not re-run.** Treat as unverified on this checkout |

Outstanding before claiming a green baseline: `npm test`, `npm run typecheck`, `npm run lint`, and optionally `npm run build`, after an explicit dependency install in a later task. FFmpeg-backed integration tests will skip or fail until FFmpeg is available.

---

## 8. Technical debt and blockers

Ranked by threat to correctness, resumability, data integrity, security, cost control, or the intended workflow.

1. **Cost-control hole on manual generation (high).** UI and scene services default to OpenAI. Production-run policy does not cover per-scene routes. This can spend money without `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS`.
2. **In-memory run registry (high).** Restarts lose queued/running/completed runs. Status/log 404. Resumability required by product principles is not met for server runs. Video `providerJobId` on the scene **is** persisted, so provider jobs can be polled after restart, but the run object cannot.
3. **API vs page security split (high).** Ownership is unenforced for RSC and the home server action. Local-only assumption is not encoded in bind/firewall config.
4. **Anonymous sessions + default HMAC secret (high if exposed).** Fine for single-user localhost; unsafe on any network.
5. **MCP read-only client unauthenticated (medium).** Production tools forward the token; read-only tools do not. Combined server will partially fail against P11.7.
6. **P7 audio incomplete (medium).** Narration works; music/SFX/subtitles and narration-as-timing-authority do not. Composition is narration-or-silence.
7. **No LLM narrative generation (medium for product, not a correctness bug).** P9 structure exists; director workflow is still manual.
8. **Intent materialization produces blank scenes (medium).** Extra manual step before production plan can generate visuals.
9. **FFmpeg missing in this environment (blocker for local render verification).**
10. **No `node_modules` (blocker for test/typecheck/lint in this checkout).**
11. **Gemini and ScriptGenerator stubs (low).** Types without adapters.
12. **Repo hygiene (low but real).** Tracked `.next`, tmp media, missing README/env template, stale home-page copy.

Preserve the current architecture. None of these require a rewrite.

---

## 9. Recommended roadmap

At most eight items, dependency-aware.

1. **P12 — Unify fail-closed provider policy for every generation path (next).** Bind manual image/video/narration routes and the browser runner to the same mock/real policy used by `run-policy.ts`. Default mock/fake. Require explicit real mode + credentials. Closes the highest cost and safety hole without new architecture. Depends on: existing `RunPolicySnapshot` / registries.

2. **P13 — Persist production runs.** Write run snapshots and bounded logs next to the project (or a runs dir). Restore on process start; keep in-memory index. Unblocks resumability and MCP status after restart. Depends on: P11.3 service remaining the write path; P12 so restored real runs cannot accidentally continue unpaid/unallowed.

3. **P14 — Close the page/MCP auth gap for local multi-surface use.** Session bootstrap on home, owner-aware list/create in RSC, read-only MCP bearer forwarding, replace default session secret with required env in non-dev. Still not "public safe." Depends on P11.7 helpers.

4. **P15 — Audio completeness (P7 remainder).** Optional music bed, volume mix from `renderSettings.audio`, subtitle sidecar or burn-in gated by `subtitlesEnabled`, optional scene-duration sync from narration duration. Depends on existing compositor and freshness fingerprint (extend fingerprint if mix inputs matter).

5. **P16 — Intent-to-visual materialization.** When materializing approved intents, create `generated_image` scenes with prompts derived from visualIntent/narrationDraft instead of blank visuals, without auto-calling providers. Unblocks production runs after story. Depends on P9 materializer.

6. **P17 — LLM director adapter (optional, behind mock/real policy).** Implement `ScriptGenerator` with fake + one real provider, fail-closed, writing story/beats/intents only. Depends on P12 policy and P9 models.

7. **P18 — Operator baseline.** README, `.env.example` (placeholders only), gitignore `.next`/`*.tsbuildinfo`/tmp media, document FFmpeg and `PRODUCTION_RUN_*` / `EXPLAINER_*`. No secrets. Can overlap earlier phases.

8. **Defer public exposure.** No tunnel, no "safe for internet" claim, until network bind, TLS, non-default secrets, durable rate limit, and identity are explicitly designed. Out of scope until the owner asks.

Why P12 first: the studio already generates, narrates, renders, composes, and orchestrates. The next coherent increment is making every paid call go through the policy that already exists for server runs. Persistence and auth hardening matter, but accidental OpenAI defaults can burn money as soon as a key is present.

---

## 10. Recommended next task

### Title

P12: Fail-closed generation policy on manual routes and the browser runner

### Goal

Make mock vs real provider selection a single server-side policy for **all** image, video, and narration generation, not only headless production runs. Default to mock. Fail closed when real credentials or allow-real are missing. Do not redesign storage, rendering, or MCP.

### Current architecture to reuse

- `resolveRunPolicy()` / `assertRunPolicyPreflight()` / `resolveRunPolicyServerConfig()` in `lib/production/run-policy.ts`
- Registries in `lib/ai/*/registry.ts`
- `generateSceneImage`, `submitSceneVideoGeneration`, `generateSceneNarration`
- Route handlers under `app/api/projects/[id]/scenes/[sceneId]/generate-*`
- Browser calls in `components/project/project-workspace.tsx` (`runProduceReady`, per-scene generate buttons)
- Existing tests: `tests/run-policy.test.ts`, `tests/image-generation-service.test.ts`, `tests/video-generation-service.test.ts`, `tests/narration-service.test.ts`, `tests/api-security-boundary.test.ts`

### Scope

1. Introduce a shared helper (keep it in `lib/production` or `lib/generation`) that resolves the effective provider for a generation request from: explicit request provider, scene record, and server policy. In mock mode, force fake/local. In real mode, require allow-real + credentials, no silent fallback.
2. Change image default from `'openai'` to policy default (`fake` unless real mode is enabled). Same for video (`local`/`fake`). Narration must not auto-select ElevenLabs merely because a key exists unless real mode is allowed.
3. Thread the helper through the three generate route handlers and, if needed, the generation services so browser batch and manual buttons cannot bypass it.
4. Keep production-run locking behavior unchanged; reuse the same resolver so run + manual cannot disagree.
5. Update UI defaults and copy so new scenes do not show OpenAI as the implicit default when the server is in mock mode. Surface configured vs not without implying a paid call will proceed.
6. Add tests: mock server rejects openai on manual generate; real mode without key fails before provider HTTP; explicit fake works without keys; production-run tests still pass.
7. Do not call live OpenAI/ElevenLabs. Do not persist runs. Do not add Gemini. Do not change FFmpeg. Do not install unrelated frameworks.

### Out of scope

- Run registry persistence
- RSC/home auth
- Music/subtitles
- LLM script generation
- Public deployment
- Rewriting the planner or renderer

### Acceptance criteria

- With default env (no `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS`), `POST generate-image` / `generate-video` use fake/local and never construct a paid request.
- Setting a scene's `generation.provider` to `openai` in mock mode fails closed (403/409), not a paid call.
- Real mode remains explicit, credential-checked, and mixed fake/real providers remain rejected.
- Existing ownership/throttle on those routes remains.
- Tests covering the new policy pass; prior run-policy and generation tests remain green once dependencies are available.
- No secrets written to the repo.

### Implementation-ready notes

- Highest-leverage files: `lib/generation/image-generation-service.ts` (line with `|| 'openai'`), `lib/generation/video-generation-service.ts` (`VIDEO_GENERATION_DEFAULT_PROVIDER || 'openai'`), `lib/generation/narration-service.ts` (`resolveDefaultProvider()`), `app/api/projects/[id]/scenes/[sceneId]/generate-*.ts`, `components/project/project-workspace.tsx` `defaultScene()`.
- Prefer extending `run-policy.ts` over a second policy language.
- After this lands, P13 (durable runs) is the natural follow-up.

---

## Assumptions and outstanding runtime checks

Assumptions (not verified):

- Prior 184-test green run was accurate for the code now in HEAD.
- Operators intend localhost/single-user use unless they say otherwise.

Outstanding:

- `npm test` / `typecheck` / `lint` / `build` after install
- FFmpeg availability for render integration tests
- Actual bind address / firewall / tunnels in any live process
- Whether `EXPLAINER_API_TOKEN` / session secret / provider keys are set in a real deployment (do not dump values)

This checkout is a coherent local-first studio through P11.7, with working domain, providers, narration, FFmpeg pipeline (code), orchestration, MCP, and API authz. It is not verification-green in this environment, not public-safe, and not fail-closed on the interactive generation path. Next implementation should close that path without rewriting the stack.
