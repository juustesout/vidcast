# P43 - FAL.ai Image-to-Video Pilot Input

Status: **DONE (input registration + local validation only).** No application code
was changed, nothing was committed or pushed, no FAL request was made, no paid
generation occurred, and no credential value was read, printed or modified. No
network call of any kind was made in this phase.

Goal: resolve the P42 blocker by making the already-validated PNG usable as a
`startFrameReferenceId` through the existing reference flow, in a dedicated pilot
project, and then validate the wiring with local (no-network) checks only.

Convention: **[code]** = verified by reading this repository; **[run]** = output of
a command executed this session; **[test]** = proven by an existing automated test;
**[open]** = not yet confirmed (needs a live call).

---

## 1. Repository status and method

- Branch `main`; `HEAD = b9d7a8043729ade1d3d4266f52aabd0aee35bfed` equal to
  `origin/main` **[run]**. No tracked file modified; no `.gitmodules`.
- Untracked recon docs (`p29`, `p29.2`, `p31`, `p33`, `p35`, `p37`, `p38`, `p40`,
  `p42`) and this report are left untouched / intentionally untracked. Gitignored
  `projects/` left intact.
- Method: the dedicated pilot project and its reference were created with
  `projectStore.createProject` and `projectStore.importReference` **[code]** - the
  exact functions the application's routes call (`app/api/projects/route.ts`,
  `app/api/projects/[id]/references/route.ts:56`). The one-off driver lives outside
  the repo at `/tmp/opencode/p43-pilot.ts` and is not part of the project.
- No generation entry point was invoked: the scene was only shaped to reference the
  registered image; no submit/poll/download ran.

---

## 2. Pilot project and registered reference

### 2.1 Pilot project **[run]**

- id: `project_9a05a830-88ff-4435-a10f-ff6495937ebc`
- title: `P43 i2v pilot 2026-10-13T08:41:46.581Z`
- description: dedicated FAL image-to-video input-validation pilot; no paid generation.
- `aspectRatio` 16:9, `durationTarget` 5, `fps` 24, `scenes` 1, `references` 1.
- A new dedicated project was created; no existing/user project was modified.

### 2.2 Registered reference **[run]**

- id: `reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4`
- name: `Scene 01 start frame`, tags `["start_frame","i2v"]`
- `filePath`: `references/reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4-scene-01-start-frame.png`
- `metadata.mimeType`: `image/png`; `metadata.width` x `height`: 1536 x 1024;
  `metadata.filesize`: 2693455.

---

## 3. Reference <-> file <-> SHA-256 relation

| Item | Value |
| --- | --- |
| Source asset (P42 selection) | `projects/project_afca8256-f75c-4f75-9779-26ae34f7b209/assets/scene-01-generated-generation_attempt_a5624e8a-b149-4e14-8ead-93134bb5e8c8.png` |
| Source SHA-256 | `d508d002b598de3cee221e47046a9ff6d5d11c82128fc9af55a9c2905b478142` |
| Source bytes / dimensions | 2693455 / 1536x1024 (ratio 3:2) |
| Expected SHA-256 (P42) match | true **[run]** |
| Reference id | `reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4` |
| Stored file (relative) | `projects/project_9a05a830-88ff-4435-a10f-ff6495937ebc/references/reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4-scene-01-start-frame.png` |
| Stored SHA-256 | `d508d002b598de3cee221e47046a9ff6d5d11c82128fc9af55a9c2905b478142` |
| Byte-identical to source | true **[run]** |
| Stored decodes | true (1536x1024 via `image-size`) **[run]** |

`projectStore.importReference` writes the uploaded bytes verbatim
(`media-store.ts:saveReference`, `:215`), so the registered reference is a
byte-identical copy of the validated asset and its SHA-256 is preserved. The
original asset was read only, never modified or moved.

---

## 4. Scene wiring and local validation

### 4.1 Scene **[run]**

- `scene_90665c67-68c4-4a40-919b-78b90f44eb9e`: `type` `video`, `duration` 5.
- `referenceIds`: `["reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4"]`
- `visual.generation.referenceIds`: same id.
- `visual.generation.startFrameReferenceId`: `reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4`
- `visual.generation.model`: `minimax/h3-max-turbo/image-to-video`; `provider` `fal`;
  `aspectRatio` 16:9.

The frame id belongs to the effective `referenceIds`, satisfying the P41 contract
(`getReferenceById` resolves only from `project.references`, and
`assertFrameReferences` runs before any provider call) **[code]**.

### 4.2 `validateProject` result **[run]**

- `valid`: true; `errors`: none; `warnings`: none;
  `scene.visual.generation.frameReference.missing` count: 0.

### 4.3 Existing test coverage (local, no network) **[run]**

`npx vitest run tests/fal-video-service.test.ts tests/fal-video-provider.test.ts
tests/run-policy.test.ts tests/video-generation-service.test.ts
tests/project-update.test.ts` -> **5 files, 92 tests passed**. This includes the
i2v submit/resume/download path that turns keyframe references into base64 data URIs
(`tests/fal-video-service.test.ts:338`) and the mock/real policy tests
(`tests/run-policy.test.ts`) **[test]**.

### 4.4 Mock-mode / no-FAL confirmation **[code]** **[test]**

- Server config defaults to `mode = mock` unless `PRODUCTION_RUN_ALLOW_REAL_PROVIDERS`
  is enabled; in mock mode a real provider (`fal`) is rejected before any request
  (`run-policy.ts:588`, "Mock mode only allows fake/local providers").
- No generation was executed in P43, so there is no FAL submit, poll or paid call.

---

## 5. Blocker resolution and remaining risks

- **B1 (P42) resolved**: previously no raster image existed under `references/`; now
  the validated PNG is registered as a reference in a dedicated pilot project, and
  `startFrameReferenceId` resolves to it under local validation.

Remaining **[open]** items (unchanged from P42; require the first live call):
- Per-field image limits (MIME / bytes / pixels) are not published.
- Base64 data-URI acceptance is documented only at the Files-section level.
- The chosen frame is 3:2 while the project is 16:9; the i2v canvas follows the image,
  so the clip is expected to come back 3:2 regardless of the project `aspectRatio`.
- The i2v queue path is expected to be `minimax/h3-max-turbo` (endpoint sub-path
  dropped) - to be confirmed on the first submit.
- This phase used the store functions the API wraps, not a full HTTP round trip; if a
  literal HTTP upload is required, that is a small follow-up.

---

## 6. Go / No-Go

**Conditional Go** for one live image-to-video submit, < $1, using pilot project
`project_9a05a830-88ff-4435-a10f-ff6495937ebc` and reference
`reference_0cbe7ade-10bb-418e-822b-c0fbbe69d2f4`: the input is now registered and
locally validated, mock mode issues no FAL request, and the paid path is unchanged
from the P41 implementation. No commit or push was performed for this phase.
