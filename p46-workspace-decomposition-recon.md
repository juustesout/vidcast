# P46 — ProjectWorkspace Decomposition Recon

Recon only. No application code, tests, fonts, session init, project claiming or
polling were modified. This document is additive; `p46-startup-and-codebase-health-recon.md`
and all other `p29`…`p45` recon docs are untouched.

## 1. Scope and method

Target: `components/project/project-workspace.tsx` (the `ProjectWorkspace` client
component rendered by `app/projects/[id]/page.tsx`).

Method:
- Read the file end-to-end in segments and mapped every hook, ref, effect, handler,
  JSX region and local leaf component.
- Traced every import to its target module to find responsibilities that already have
  a service/hook/component boundary.
- Grepped the whole `tests/` tree for direct source-inspection of this file.
- Measured objective size/complexity and the shipped client chunk from the existing
  `.next` build output.
- Read git history for churn on the file.

No live AI calls, no secrets, no commit/push.

## 2. Size and complexity (objective)

| Metric | Value |
| --- | --- |
| Lines | 2,684 |
| Bytes | 129,157 |
| `useState` | 24 |
| `useEffect` | 5 |
| `useMemo` | 17 |
| `useCallback` | 1 |
| `useRef` | 5 |
| `async function` declarations | 16 |
| inner `function`/`async function` declarations in component | 27 |
| `fetch(...)` call sites | 16 |
| distinct `set*` state setters | 54 |
| commits touching the file (`git log`) | 5 of 34 total |

The component body spans lines 226–2503; only ~225 lines are module-level helpers
and ~180 lines are trailing leaf components.

## 3. Responsibility map

### 3.1 Module-level helpers (lines 35–224)
- Types/constants: `ProjectWorkspaceProps`, `VisualMode`, `WorkspaceTab`,
  `AssetFilter`, `StoryFocusArea`, `GRAPHIC_TEMPLATES`.
- Pure helpers: `cloneProject` (46), `defaultScene` (50), `visualModeOf` (81),
  `ensureVisualForMode` (85), `assetTypeGroup` (129), `formatSize` (142),
  `formatDuration` (156), `formatRunEventTime` (163), `actionTypeLabel` (168),
  `actionStatusIcon` (187), `runStatusLabel` (208).

### 3.2 State (227–265)
- Domain: `draft` (227).
- Navigation/selection: `activeTab`, `selectedSceneId`, `selectedAssetId`,
  `selectedReferenceId`, `storyFocusArea`, `storyFocusRequestId`, `assetFilter`,
  `assetQuery`, `referenceQuery`.
- Messaging: `saveMessage`, `renderMessage`, `compositionMessage`, `assetMessage`,
  `referenceMessage`, `generationMessage`, `narrationMessage`.
- Busy flags: `renderingSceneId`, `composingProject`, `narrationMessage`,
  `narratingSceneId`, `generatingSceneId`, `batchRunning`.
- Production-batch state: `batchSummary`, `batchOutcome`, `batchMessage`,
  `batchFailedActionIds`, `batchEvents`, `batchLogOpen`, `batchCopyState`.
- Composition/asset summaries: `lastRender`, `lastComposition`, `compositionFailed`,
  `providerStatus`.
- Reference intake form: `newReferenceName`, `newReferenceDescription`,
  `newReferenceTags`.

### 3.3 Refs (260–269)
- `isVideoPollingRef` (260), `batchCopyResetTimerRef` (261),
  `sceneAssetFileInput` (267), `libraryAssetFileInput` (268),
  `referenceFileInput` (269).

### 3.4 Derived values (271–334)
`selectedScene`, `selectedAsset`, `selectedReference`, and pure derivations:
`validation` (279), `renderPlan` (280), `generationTasks` (281),
`compositionReadiness` (282), `finalCompositionStatus` (283), `workflow` (284),
`productionPlan` (291), `productionSceneGroups` (300), `liveActivityRows` (301),
`recentRunnerEvents` (312), `activeWorkflowStepId` (318),
`selectedSceneRenderStatus` (319), `activeVideoAttemptIds` (320),
`filteredAssets` (368), `filteredReferences` (392), `audioAssets` (406),
`hasNarrationAudioInProject` (410).

### 3.5 Effects (336–366, 1064–1124)
- 336: one-shot `GET /api/image-generation/status` → `providerStatus`.
- 346: sync `lastComposition` from `draft.compositions`.
- 353: sync `lastRender` from selected scene renders.
- 360: unmount cleanup for `batchCopyResetTimerRef`.
- 1064: video-generation polling (Phase D, visibility-aware) + refresh project.

### 3.6 Draft mutation handlers (414–561)
`updateProject`, `requestStoryFocus`, `navigateFromWorkflow`, `updateScene`,
`setSceneReferences`, `setSceneFrame`, `referenceName`, `updateOverlay`, `addScene`,
`setVisualMode`, `setAssetForScene`.

### 3.7 Persistence / async I/O
- `saveProject` (563) PUT `/api/projects/:id`.
- `refreshProject` (582) GET `/api/projects/:id`.
- `renderProject` (1126) via `createSceneRenderRequest`.
- `composeProjectVideo` (1164) via `createProjectCompositionRequest`.

### 3.8 Production orchestration (594–897)
- `executeProductionAction` (594–785): per-action-type fetch mapping
  (`image_generate`, `video_submit`, `video_poll`, `narration_generate`,
  `scene_render`, `final_compose`) returning `ProductionActionExecutionOutcome`
  and throwing `createProductionRunnerError`.
- `runProduceReady` (787–868): save → `runProductionBatch` → progress/event
  callbacks → refresh.
- `copyProductionLog` (870–897): `formatProductionLogAsText` + clipboard.

### 3.9 Generation / narration (899–1062)
`runImageGeneration` (899), `runVideoGeneration` (934), `cancelVideoGeneration`
(986), `runNarrationGeneration` (1015), `pollVideoGenerationAttempt` (1036,
memoized).

### 3.10 Asset / reference handlers (1207–1315)
`importAsset` (1207), `deleteSelectedAsset` (1233), `importReference` (1252),
`saveReferenceDetails` (1277), `deleteSelectedReference` (1297).

### 3.10 JSX regions (1317–2502)
| Region | Lines | Notes |
| --- | --- | --- |
| Editor header (title/desc/settings + actions) | 1319–1420 | render/compose/open buttons, readiness cards |
| `ProductionWorkflow` | 1422–1430 | extracted component |
| Production section | 1432–1528 | batch controls, `ServerRunPanel`, live activity, plan groups |
| Batch log modal | 1530–1587 | telemetry modal |
| Tab bar | 1589–1595 | 5 tabs |
| Story tab | 1597–1609 | `ExplainerStoryWorkspace` |
| **Scenes tab** | **1611–2231 (~620)** | scene list, `ScenePreview`, huge scene inspector |
| Assets tab | 2233–2334 | `BackgroundMusicPanel` + asset grid/detail |
| References tab | 2336–2400 | reference grid + `ReferenceDetailCard` |
| Generation tab | 2402–2496 | per-generation-task cards |
| Validation | 2498–2500 | `ValidationPanel` |

### 3.11 Trailing leaf components (2505–2684)
`TabButton` (2505), `InfoMiniCard` (2517), `ReferenceDetailCard` (2526),
`Field` (2598), `SelectField` (2651), `EmptyPanel` (2682).

## 4. Responsibilities that already have a boundary

The component already delegates all non-trivial logic to tested modules. Only thin
React glue + presentation remain:

| Import | Module | Role |
| --- | --- | --- |
| `ExplainerStoryWorkspace` | `components/project/explainer-story-workspace.tsx` | story tab |
| `BackgroundMusicPanel` | `components/project/background-music-panel.tsx` | music |
| `ProductionWorkflow` | `components/project/production-workflow.tsx` | workflow nav |
| `ServerRunPanel` | `components/project/server-run-panel.tsx` | server-run lifecycle/UI |
| `ScenePreview` | `components/preview/scene-preview.tsx` | scene render preview |
| `ValidationPanel` | `components/project/validation-panel.tsx` | validation UI |
| `createScene{Narration,Render}Request`, `createProjectCompositionRequest` | `lib/client/render-client.ts` | render/narration/compose I/O |
| `deriveProductionPlan`, `groupProductionActionsByScene` | `lib/production/production-planner.ts` | plan |
| `runProductionBatch`, `createProductionRunnerError` | `lib/production/production-runner.ts` | batch engine |
| `formatProductionLogAsText` | `lib/production/production-log-export.ts` | log text |
| `deriveComposition{Readiness,ArtifactStatus}`, `deriveSceneRenderStatus`, `formatRenderStatusLabel` | `lib/render/render-status.ts` | status |
| `resolveRenderPlan` | `lib/render/scene-resolver.ts` | render plan |
| `deriveGenerationTasks` | `lib/projects/generation-tasks.ts` | generation list |
| `getAssetUsage`, `getReferenceUsage` | `lib/projects/usage.ts` | usage |
| `resolveVideoProviderForwarding` | `lib/generation/video-provider-forwarding.ts` | provider forwarding |
| `deriveWorkflowStatus`, `deriveActiveWorkflowStepId` | `lib/workflow/*` | workflow |
| `validateProject` | `lib/validation/project-validation.ts` | validation |
| `isHidden`, `subscribeToVisibility` | `lib/client/visibility-poll.ts` | idle-aware polling |
| `joinProject{Asset,Reference}Url` | `lib/utils/project-files.ts` | url helpers |
| `createId` | `lib/utils/ids.ts` | ids |

Conclusion: the domain logic is already extracted. This file is a **"controller +
view" component** whose size comes from breadth (5 tabs, 6 action types, 2 editing
surfaces), not from misplaced algorithms.

## 5. Highest-risk coupling points

1. **`draft` whole-object state.** Every mutation is `updateProject({ ...draft, … })`
   or `updateScene` over `draft`; asset/reference import handlers close over `draft`
   and re-expand it. Any extraction that keeps a local copy risks stale-state writes.
2. **Shared scalar flags drive correctness**: `generatingSceneId`, `narratingSceneId`,
   `renderingSceneId`, `composingProject` are read by `runProduceReady` to seed
   `ProductionPlan` runtime (`:811–814`). Splitting these apart can desynchronize the
   runner's notion of "in-flight".
3. **`saveProject` semantics.** It is the save-before-produce gate and is also passed
   as `onEnsureSaved` to `ServerRunPanel` and used by `renderProject` /
   `composeProjectVideo`. A single authoritative save path must be preserved;
   duplicating it would break save-before-run and the server-run panel contract.
4. **Production-run lifecycle + polling.** `executeProductionAction` interleaves
   state setters with fetches; `pollVideoGenerationAttempt` + the 1064 effect +
   `isVideoPollingRef` implement overlap/visibility semantics (Phase D). These must
   not be reshaped by extraction.
5. **Cross-tab selection coupling.** `selectedSceneId`, `selectedAssetId`,
   `selectedReferenceId` are set from within scene inspector, assets tab, generation
   tab and references tab, then switch `activeTab`. These are the main reason
   tab-local extraction is not a clean cut.
6. **`activeVideoAttemptIds` identity.** `useMemo(..., [draft.scenes])` feeds the
   poll effect; if a refactor returns a new array identity per render it would
   re-subscribe/re-poll.

## 6. Testability assessment

- `ProjectWorkspace` is **never rendered in tests**. `tests/page-authorization.test.ts`
  mocks the module to `() => null`; there are no interactive/unit tests for it.
- **Four** tests inspect the file as text (`fs.readFileSync(... 'components/project/project-workspace.tsx')`):
  - `tests/project-workspace-overlay-controls.test.tsx` — overlay labels +
    `updateOverlay` (all in the scenes-tab inspector).
  - `tests/project-workspace-video-provider.test.tsx` — provider lists, frame
    selectors, `setSceneReferences`/`setSceneFrame`, batch `video_submit` forwarding,
    cancel control.
  - `tests/project-workspace-server-run-panel.test.tsx` — mounts panel, `Produce N`,
    `ServerRunPanel` mount, plus Phase D idle-poll guards.
  - `tests/session-bootstrap-init.test.ts` — asserts the file does **not** call
    `/api/auth/session` (baseline invariant).
- The repo has **no jsdom / @testing-library**; component tests use
  `react-dom/server` `renderToStaticMarkup` and mock `next/image`
  (`tests/background-music-panel.test.tsx`, `tests/scene-preview.test.tsx`). Pure
  presentational leaves are therefore SSR-testable; stateful containers are not.
- Independently testable today (SSR or pure): the trailing leaf components
  (`Field`, `SelectField`, `InfoMiniCard`, `TabButton`, `EmptyPanel`,
  `ReferenceDetailCard`), the module-level formatters, and — via extraction —
  the production action fetch mapping.

## 7. Runtime vs maintainability verdict

**Evidence (measured):**
- `ProjectWorkspace` is the sole client entry for the route: `app/projects/[id]/page.tsx`
  is a server component that renders `<ProjectWorkspace project={project} />`, and the
  file is `'use client'`. The entire client graph hangs off it.
- Shipped client chunk `.next/static/chunks/app/projects/[id]/page.js`:
  **2,164,678 bytes raw / 469,321 bytes gzip**, vs the landing route
  `app/page.js` at **46,766 bytes gzip** (≈10x). The route ships a heavy client graph.
- There is **no** `next/dynamic`, `React.lazy` or `dynamic()` anywhere in
  `components/`, `app/`, `lib/` source — the route is not code-split.
- Cold-route compile dominates first-request latency (established in the P46 startup
  recon); a 2,684-line module plus its graph is a compile-cost contributor.

**Assumption (not proven):**
- That splitting this one file into more modules shrinks the shipped bundle or
  improves runtime. Moving code into sibling modules **does not reduce bundle size**
  by itself — those modules are still imported by the same client entry. Only
  code-splitting (e.g. `next/dynamic` per tab) or trimming imports would change the
  payload. No measurement was taken isolating this file's contribution vs. the rest
  of the graph (scene-preview, explainer, production libs).

**Verdict:** The 2,684-line file is a **maintainability bottleneck first** (single
mutable `draft`, 24 state fields, 27 inner functions, 54 setters, reviewed for every
tab/action change) and a **runtime/compile contributor second** (heavy unsplit client
chunk, slow cold compile). Decomposition addresses the maintainability cost directly;
it will **not** by itself reduce the runtime payload unless paired with lazy-loading,
which is out of scope here. Churn evidence is weak (only 5 of 34 commits touched the
file), so the case rests on breadth/coupling, not on measured defect rate.

## 8. Recommended extraction candidates (ordered: lowest risk → highest benefit)

Given the constraints (preserve behavior/API/MCP/production reliability; no broad
rewrite; do not touch fonts, session init, claiming or polling), the following are
proposed. None of them move polling, save semantics, or the production-run lifecycle.

### Candidate 1 — Shared workspace form/presentational primitives (lowest risk)
- **Proposed file:** `components/project/workspace-controls.tsx`
- **Move:** `Field` (2598), `SelectField` (2651), `InfoMiniCard` (2517),
  `TabButton` (2505), `EmptyPanel` (2682).
- **Dependencies:** React only (`useId`). No state, no effects, no fetch.
- **Public interface:** the existing prop signatures, exported.
- **De-duplication:** `explainer-story-workspace.tsx` defines its own `Field`
  (592–627). Unify into the shared one with a superset of props
  (`rows` + `suggestions` + numeric coercion). **Risk note:** the two `Field`s
  differ (number coercion, `datalist` suggestions, class strings); unify carefully
  to avoid a visual/behavioral change, or leave explainer's copy in place for a first
  low-risk pass.
- **Tests:** add SSR tests (`renderToStaticMarkup`) for each primitive under
  `tests/workspace-controls.test.tsx`. Existing source-guard tests are unaffected
  (their asserted strings live in the scenes-tab inspector, not in these leaves).
- **Benefit:** ~180 lines out of the monolith + removes a real duplication; very
  low blast radius.

### Candidate 2 — References tab + handlers + detail card (low risk, clean boundary)
- **Proposed file:** `components/project/references-panel.tsx`
- **Move:** the references-tab JSX (2336–2400), `ReferenceDetailCard` (2526–2596),
  and handlers `importReference` (1252), `saveReferenceDetails` (1277),
  `deleteSelectedReference` (1297); carry the reference-local state
  (`selectedReferenceId`, `newReferenceName/Description/Tags`, `referenceQuery`,
  `referenceMessage`) into the new component.
- **Dependencies:** `getReferenceUsage` (`lib/projects/usage.ts`),
  `joinProjectReferenceUrl` (`lib/utils/project-files.ts`), `next/image`, and the
  shared primitives from Candidate 1.
- **Public interface:**
  `ReferencesPanel({ project, onProjectChange, onNavigateScene, onSelectedReferenceChange? })`.
  It receives the whole project and emits a new whole project (preserving the
  existing `updateProject({...draft, references})` write path), plus a navigate
  callback for "used by scenes".
- **State coupling to resolve:** `selectedReferenceId` is also referenced by the
  generation-tab thumbnail (`:2085`) and scene inspector; keep the id in the parent
  or expose it via callback so cross-tab navigation is preserved.
- **Tests:** move nothing today (no reference-specific test exists); add an SSR test
  for `ReferenceDetailCard` and a source-guard test for the panel. Unaffected:
  overlay-controls, video-provider, server-run-panel, session-bootstrap guards.
- **Benefit:** ~150 lines removed; a genuinely self-contained editing surface.

### Candidate 3 — Production action execution client (highest logic benefit, moderate risk)
- **Proposed file:** `lib/client/production-action-client.ts`
  (optionally paired with `components/project/use-production-orchestration.ts`).
- **Move (phase 1, pure I/O):** the fetch-mapping switch of
  `executeProductionAction` (594–785) into a function
  `executeProductionAction(action, context)` where `context` supplies
  `projectId`, `project` (for scene lookups), and lifecycle callbacks
  (`onGeneratingSceneId`, `onNarratingSceneId`, `onRenderingSceneId`,
  `onComposing`, `onCompositionFailed`). It keeps throwing
  `createProductionRunnerError` and returns the same
  `ProductionActionExecutionOutcome`.
- **Leave in place (phase 2, only if desired):** `runProduceReady` state machine and
  all `batch*` React state — a thin `useProductionOrchestration` hook can own those
  and call the new client, but this is optional and higher risk.
- **Dependencies:** `lib/client/render-client.ts`,
  `lib/generation/video-provider-forwarding.ts`,
  `lib/production/production-runner.ts` (error factory).
- **Public interface:** a single async mapper; no React import in the client module.
- **Tests that must move/extend:**
  - New `tests/production-action-client.test.ts` with `fetch` mocks covering all six
    action types + error paths (this is the main win — logic currently only
    source-guarded).
  - `tests/project-workspace-video-provider.test.tsx` assertions about the batch
    `video_submit` forwarding (`:98–100`) move to the new test because that code
    leaves the component. The manual `runVideoGeneration` assertions stay.
  - `tests/project-workspace-server-run-panel.test.tsx` "Produce N" mount assertion
    stays (JSX unchanged).
- **Do not touch:** `pollVideoGenerationAttempt`, the 1064 poll effect, `saveProject`,
  or `runProduceReady`'s save-before-run ordering.
- **Benefit:** ~190 lines of async glue removed from the component and converted from
  source-guard-only to unit-tested; directly reduces the riskiest surface.

### Evaluated but not recommended (now)
- **Scenes-tab inspector** (1641–2229, ~590 lines): the single biggest block and the
  most-edited (overlay + video authoring). It is also the most coupled — it consumes
  ~12 handlers, 3 refs, 4 derived statuses and cross-tab selection setters, and it is
  the subject of the overlay/video source-guard tests. Extracting it would require a
  wide prop contract and rewriting two source-guard suites; high risk relative to the
  other three. Defer until the primitives (C1) and patterns (C2/C3) exist.

## 9. Non-goals / invariants to preserve for any follow-up work
- Do not alter `saveProject` / save-before-produce / `onEnsureSaved` contract.
- Do not alter `executeProductionAction` semantics (endpoints, error codes, provider
  forwarding, `final_compose` failure handling).
- Do not alter `pollVideoGenerationAttempt`, `isVideoPollingRef`, or the Phase D
  visibility-aware poll effect.
- Keep `app/projects/[id]/page.tsx` server boundary, MCP workflows and API routes
  unchanged.
- No new runtime dependency; no jsdom/@testing-library introduction assumed
  (SSR `renderToStaticMarkup` is the established component-test style).

## 10. Verification / no-change statement
This task modified no application code and no tests. Confirmed working tree matches
the P46-Phase-D state described in `p46-startup-and-codebase-health-recon.md`:
branch `main`, HEAD `d935182`, Phase A–D edits present and uncommitted, recon docs
`p29`…`p46` untracked and untouched. Only this new file was added.
