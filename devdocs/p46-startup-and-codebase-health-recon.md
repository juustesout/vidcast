# p46 - Development Startup & Codebase Health Recon

Recon only. No code changed, no paid/live provider calls, no commit/push.
Base commit at time of writing: `d935182` (`feat(mcp): complete Hermes video workflow`), branch `main`, 1 ahead of `origin/main` (unpushed).

## 1. Startup log facts (observed)

- Next.js 15.5.27, dev server, `http://localhost:3000` (+ `0.0.0.0:3000`), ready in ~55.4s.
- `socket hang up` followed by `Retrying 1/3...` while compiling `/`.
- `GET /` first request: **48796ms**; later `/` requests 359/533/534ms.
- `GET /projects/[id]`: **19398ms** first, then 359/533/534ms.
- `POST /api/auth/session 200 in 3898ms` logged **twice**.
- `GET /api/image-generation/status`: **7256ms** first, then 187ms.
- middleware compiled 1731ms.

Interpretation: the multi-second first requests are **cold-route compilation** (dev compiles the route + its module graph on first hit; 860 modules for `/`). Repeat hits drop to sub-second, which is the signature of "compiled once, now cached" — not a server-side hang.

## 2. Likely cause of `socket hang up` + `Retrying 1/3`

**Root cause: `next/font/google` network fetch in the root layout.**

Evidence chain:
- `app/layout.tsx:2` imports `Inter`, `IBM_Plex_Mono`, `Fraunces` from `next/font/google` and applies all three in the root `<html>`.
- The only producer of the string `Retrying N/N...` in the installed Next tree is `node_modules/next/dist/compiled/@next/font/dist/google/retry.js:14` (`console.error(e.message + "\n\nRetrying ${attempt}/${retries}...")`).
- Font CSS fetch is wrapped by that retry helper: `fetch-css-from-google-fonts.js:23` calls `retry(fetchResource, 3)` → exactly `Retrying 1/3`.
- `fetch-resource.js` performs a raw `node:https` GET; on `req.on('error')` it rejects with the raw error, whose message for a reset connection is `socket hang up` (`fetch-resource.js:48`). In dev it also arms a 3000ms timeout.
- So: during compile of `/`, Next fetched the Google Fonts CSS/woff2, the connection was reset (transient sandbox network not ready at boot), the error surfaced verbatim as `socket hang up`, and the retry loop printed `Retrying 1/3`.

**Real error vs normal first compile:** The `socket hang up` was a **transient dev-time network failure fetching Google Fonts**, not a hung application request and not a code bug. A live bounded check now succeeds fast (`fonts.googleapis.com` HTTP 200 in ~0.2s, `fonts.gstatic.com` woff2 HTTP 200 in ~0.18s), confirming the failure was transient (DNS/egress not ready at container boot). It amplified the `/` cold compile to ~48s because three fonts × (CSS + files) × up to 3 retries serially on a 3s dev timeout. No font cache directory was found under `.next`, so each cold dev start re-fetches.

## 3. Duplicate `POST /api/auth/session`

Two independent client callers fire on mount:
- `components/session/session-bootstrap.tsx:28` — `fetch('/api/auth/session', { method: 'POST' })`.
- `components/project/project-workspace.tsx:271` — `void fetch('/api/auth/session', {...})`.

Both run before the session cookie is set, so they **race**: two anonymous subjects are generated and `claimUnownedProjects` can run twice. This explains the duplicate `POST /api/auth/session` log entries.

Cost of the endpoint: `app/api/auth/session/route.ts:28` calls `projectStore.claimUnownedProjects(subject)` → `lib/storage/project-store.ts:710`, which:
- calls `ensureSeedProject()` (`project-store.ts:574`) — on a truly cold data dir this **writes a sample project + ~6 placeholder SVG files**; afterwards it is a single `readdir` guard;
- serial `readdir(getProjectsRoot())` then serially `readProjectFile()` for every project directory.

This serial seed/scan is the plausible source of the 3898ms cost (largest on a cold data dir).

## 4. `GET /api/image-generation/status`

- Caller: `components/project/project-workspace.tsx:345`.
- Backed by a 5s poll: `project-workspace.tsx:1100` `window.setInterval(poll, 5000)`.
- First call 7256ms = cold-route compile; subsequent 187ms = steady state. Not a leak, but a fixed 5s poll when idle.

## 5. Structural cost drivers (candidates, not yet actioned)

1. **Google Fonts at boot** (3 families) with dev 3s timeout + 3 retries, no local fallback/cache → brittle cold start, network-fetch dependency at compile.
2. **`project-workspace.tsx` is a 2662-line `'use client'` component** importing ~25 `lib/*` modules (constants, render-client, generation-tasks, video-provider-forwarding, render-status, usage, overlay-resolve, scene-resolver, workflow-navigation, workflow-status, production-planner, production-runner, production-log-export, project-validation) plus 4 child client components → large client compile/bundle and a broad recompile surface.
3. **Duplicate session init** (two callers) causing a race and double `claimUnownedProjects`.
4. **Serial seed/claim FS work** on the session path.
5. **Fixed 5s status poll** regardless of activity.

## 6. Codebase inventory (health)

- Routes: 31 `app/**/route.ts`; render/page surface: 8 `'use client'` components.
- `lib/ai/`: `image-generation/` (openai + local), `video-generation/` (fal + local), `music/` (elevenlabs + fake), `text-to-speech/` (elevenlabs + fake + `real-narration-pilot.ts`), `audio/` (only `audio-integrity.ts`, `silent-wav.ts` — **no provider**; audio is assembled, not synthesized here).
- Mode model is consistent: `'ln'` = local/mock sentinel, `'real'` = paid providers, gated by `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS` and per-provider confirmation env. No stray `TODO`/`FIXME`/`not implemented` markers found in `lib`/`app`/`mcp` (count 0).
- No obvious dead/duplicate provider kept as a bug; the `fake-provider.ts` files are intentional local/mock implementations.

## 7. Unsplash / stock images — existing vs missing

- **Missing entirely.** No references to `unsplash`, `pexels`, `pixabay`, `stockphoto`, or any stock-image provider anywhere outside `node_modules`.
- Image sourcing today is: OpenAI image generation (`lib/ai/image-generation`), local `'ln'` mode, plus imported/uploaded assets and references (`lib/storage/media-store.ts`, `project-store.ts` import paths). There is no stock search/import feature.

## 8. Audio / music — existing vs missing

- **Existing:** TTS via ElevenLabs + fake + `real-narration-pilot`; music via ElevenLabs + fake (`lib/ai/music`); audio post/assembly utilities in `lib/ai/audio` and mixing/timing in `lib/render`/`lib/media` (per prior audio recon docs p15/p22/p24). Background-music UI exists (`components/project/background-music-panel.tsx`).
- **Missing:** a dedicated audio-provider abstraction in `lib/ai/audio` (it holds only integrity + silent-WAV helpers); no non-ElevenLabs audio/music provider. This is by design, not a defect.

## 9. Prioritized safe cleanup candidates (none applied)

Ordered by risk-to-reward; each is independently verifiable and does not touch paid providers.

- **P1 — Make fonts local / offline-safe.** Replace or supplement `next/font/google` in `app/layout.tsx` with locally hosted font files (or `next/font/local`) so cold dev start never blocks on Google Fonts. Verify: run dev, confirm no `socket hang up`/`Retrying` and a `/` compile without network fetch. (Highest impact, lowest risk.)
- **P2 — De-duplicate session init.** Choose one owner for `POST /api/auth/session` (keep `session-bootstrap` as the single source; have `project-workspace` rely on identity instead of re-posting). Verify: exactly one session POST in dev logs; session cookie set once.
- **P3 — Make `claimUnownedProjects` bounded/cheap.** Read only what is needed (e.g. skip full parse of already-owned projects; guard the seed path) and keep it off the hot first-paint path. Verify: session POST latency and behavior unchanged functionally, fewer FS reads.
- **P4 — Reduce `project-workspace` client footprint.** Split the 2662-line component and/or move pure derivations server-side / to shared non-client modules to cut client compile and bundle breadth. Verify: `next build` bundle sizes and dev compile time for `/projects/[id]`.
- **P5 — Make the 5s status poll idle-aware** (poll only while a job is active). Verify: no recurring `/api/image-generation/status` calls when idle.

## 10. Proposed phased plan (small, separately verifiable)

- **Phase A (offline-safe fonts):** P1 only. Gate: dev cold start with no external font fetch and no `Retrying` line.
- **Phase B (single session init):** P2, then P3. Gate: one session POST; server tests green; `claimUnownedProjects` unit behavior unchanged.
- **Phase C (bundle/compile):** P4 behind a bundle-size/compile-time before/after measurement.
- **Phase D (poll hygiene):** P5.

Each phase: run `tsc`, lint, and the test suite (baseline 87 files / 653 tests) before/after; no paid/live calls.

## 11. Open questions

- Whether to keep Google Fonts at all (design/branding decision) vs vendor the three families locally.
- Desired post-cleanup cold-start target (e.g. <10s) to judge Phase A/P1 success.
- Whether stock-image search (Section 7) is in scope as a new feature; it currently has no code.
