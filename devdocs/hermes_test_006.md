# hermes_test_006.md - Render and attach Motion Canvas templates via MCP

Status: authoring contract for P102.4. Use this to list the server-owned
Motion Canvas catalog, render Northwind ARR + Nix through the local pipeline,
and attach those assets onto a studio scene.
Owner: Hermes (MCP client agent)
Depends on: `hermes_test_005.md` for studio stills / presenter / production,
and P101.5 PiP geometry on `studio-presenter`.
This file does **not** replace 005. It only adds animation MCP.

> Hard rule: do not invent MCP tools or template ids. The only catalog ids are
> `northwind_arr_chart` and `nix_overlay`. Structured JSON params only.
> Never eval TypeScript/JavaScript. Never run a shell. Never call
> `scripts/headless-render.mjs` yourself. Never point a scene at a file that
> `render_animation_template` did not return.

---

## 0. Tools (exact names)

| Step | Tool | Mutating |
| --- | --- | --- |
| 1 | `list_animation_templates` | no |
| 2 | `render_animation_template` | yes |
| 3 | `attach_animation` | yes |
| 4 | `get_scene` | no |
| 5 | `run_production` | yes |

Envelope is the same as every other tool: `{ ok: true, data }` or
`{ ok: false, error: { code, message, details? } }`.

Auth is the existing MCP bearer token. Service identity bypasses owner checks
the same way as `import_studio_assets`.

---

## 1. Catalog

Call:

```json
{ "name": "list_animation_templates", "arguments": {} }
```

Expect `data.templates` with exactly these ids:

| id | destination | output |
| --- | --- | --- |
| `northwind_arr_chart` | `bigscreen` | H.264 MP4, yuv420p, 1920x1080@30, opaque |
| `nix_overlay` | `overlay` | VP9 WebM, yuva420p, 520x780@30, alpha |

Each entry also has `allowedParamKeys`, `paramsSchema`, and `defaults`.
Unknown ids return `NOT_FOUND` (`animation.template.notFound`).
Unknown fields on later calls return `INVALID_ARGUMENT`.

Northwind defaults:

```json
{
  "title": "Northwind ARR",
  "subtitle": "Last five quarters, $M",
  "labels": ["Q1", "Q2", "Q3", "Q4", "Q5"],
  "values": [24, 41, 63, 88, 76],
  "colors": ["#38bdf8", "#60a5fa", "#34d399", "#fbbf24", "#f472b6"],
  "background": "#0f172a",
  "holdSeconds": 2.1
}
```

Nix defaults:

```json
{
  "badge": "NIX",
  "bodyColor": "#0e7490",
  "headColor": "#22d3ee",
  "badgeColor": "#ef4444"
}
```

---

## 2. Render (server-owned pipeline)

Chart:

```json
{
  "name": "render_animation_template",
  "arguments": {
    "projectId": "PROJECT_ID",
    "templateId": "northwind_arr_chart"
  }
}
```

Overlay:

```json
{
  "name": "render_animation_template",
  "arguments": {
    "projectId": "PROJECT_ID",
    "templateId": "nix_overlay"
  }
}
```

Optional `params` is a JSON object merged with defaults. Allowed keys only.
Do not send `code`, `script`, file paths, or extra fields.

Success data:

```json
{
  "projectId": "PROJECT_ID",
  "templateId": "northwind_arr_chart",
  "assetId": "asset_...",
  "localPath": "assets/...",
  "mimeType": "video/mp4",
  "destination": "bigscreen"
}
```

`localPath` is always project-relative under `assets/`. Keep `assetId` for
attach. If `ok` is false, do not attach; the scene must not point at a
missing file.

---

## 3. Attach (composition, not a new compositor)

Chart onto the bigscreen (`studio-screen`, z=10, default rect
`{x:293,y:98,width:1346,height:761}`):

```json
{
  "name": "attach_animation",
  "arguments": {
    "projectId": "PROJECT_ID",
    "sceneId": "SCENE_ID",
    "assetId": "CHART_ASSET_ID",
    "destination": "bigscreen",
    "startSeconds": 0,
    "durationSeconds": 5
  }
}
```

Nix onto the overlay (`studio-overlay`, z=25, default rect
`{x:1648,y:200,width:260,height:390}`):

```json
{
  "name": "attach_animation",
  "arguments": {
    "projectId": "PROJECT_ID",
    "sceneId": "SCENE_ID",
    "assetId": "NIX_ASSET_ID",
    "destination": "overlay",
    "startSeconds": 0.2,
    "durationSeconds": 4
  }
}
```

Optional: `scale` (0.05-2), `position: {x,y}`, `rect: {x,y,width,height}`.
Do not send unknown fields. Do not change presenter PiP or desk.

Call order: list, render chart, attach chart, render Nix, attach Nix,
then `get_scene` and confirm both layers.

---

## 4. Verify with get_scene

```json
{ "name": "get_scene", "arguments": { "projectId": "PROJECT_ID", "sceneId": "SCENE_ID" } }
```

Expect `scene.composition.preset === "studio"` and:

1. `studio-back` z=0
2. `studio-screen` z=10, `type: image`, chart `localPath`, timed 0/5
3. `studio-presenter` z=20 PiP (unchanged)
4. `studio-overlay` z=25, `type: overlay`, Nix `localPath`, timed 0.2/4
5. `studio-desk` z=30 (unchanged)

Both `localPath` values start with `assets/` and match the render responses.

---

## 5. Studio MP4

After attach, produce a real studio MP4 with the existing production tools
(`run_production` / `get_run_status` / `get_project_compositions`). Do not
invoke a local render script as a substitute for MCP.

If operator stills, `STUDIO_IMPORT_SOURCE_DIR`, or `HEYGEN_PRICING_JSON` are
missing, report that as an environment gap. The animation MCP path itself
does not require HeyGen.

---

## 6. Forbidden

- Inventing template ids or MCP tool names
- Generating or eval'ing Motion Canvas source
- Running `node scripts/headless-render.mjs` from Hermes
- Attaching an absolute path or a path outside `assets/`
- Leaving a scene pointing at a failed/incomplete render
- Redesigning WebUI
- Committing or pushing
