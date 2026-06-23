---
name: cowart-seedream-image
description: Generate and place images on the Cowart canvas through the user's own image API (Doubao Seedream on Volcengine Ark by default, or any OpenAI-compatible endpoint) instead of the built-in image model. Use when the user wants to fill a Cowart AI 图片 holder, place a generated image, or apply annotation-driven image edits while bringing their own key - especially when they have no built-in image-generation quota, or explicitly ask for Doubao / Seedream / 火山方舟 / a third-party / OpenAI-compatible image interface.
---

# Cowart Seedream Image (bring-your-own-key)

This skill generates images with the user's **own** image API and places them on the
running **Cowart** canvas. It is a companion to Cowart: it never modifies the Cowart
project and reuses Cowart's local canvas service, so the user can keep filling AI
image holders and running annotation edits **even with no built-in image quota**.

All work goes through one MCP tool from this plugin: **`generate_seedream_image`**.
It calls the image API, then writes the result into the canvas through Cowart's HTTP
API. The built-in `imagegen` skill is **not** used and no built-in quota is consumed.

## When to use this instead of `cowart:cowart-image-gen`

Prefer this skill when any of these is true:

- The user has no built-in image-generation quota, or asks to use their own key.
- The user mentions Doubao / 豆包 / Seedream / 火山方舟 / Volcengine Ark.
- The user mentions a third-party or OpenAI-compatible image endpoint (base URL + key).

Both skills can coexist. They do not conflict: Cowart's own skill uses the built-in
model, this one uses the user's API. Pick one per request based on the user's intent.

## Preconditions

1. The Cowart canvas must be running for the active project (skill
   `cowart:cowart-open-canvas`). Default URL `http://127.0.0.1:43217` (pass `cowartUrl`
   if Cowart fell back to another port such as `43218`).
2. An image API key must be available in the environment (see **Configuration**). If
   the tool reports a missing key, tell the user to set it locally and restart Codex.
   Never ask the user to paste the full key into chat.

## Configuration (environment variables)

Resolved by the MCP tool; on Windows they are also read from the user `HKCU\Environment`
registry as a fallback (so a freshly-set variable works after a Codex restart).

- `COWART_IMAGE_PROVIDER`: `doubao` (default) or `openai`.
- `COWART_IMAGE_API_KEY`: API key for the active provider. Provider aliases also work:
  `ARK_API_KEY` / `DOUBAO_API_KEY` for Doubao, `OPENAI_API_KEY` / `GAISC_API_KEY` for OpenAI-compatible.
- `COWART_IMAGE_BASE_URL`: override the endpoint. Defaults:
  - doubao -> `https://ark.cn-beijing.volces.com/api/v3`
  - openai -> `https://sub.g-aisc.com/v1`
- `COWART_IMAGE_MODEL`: override the model. Defaults:
  - doubao -> `doubao-seedream-5-0-260128`
  - openai -> `gpt-image-2`

Any of `provider`, `model`, `baseUrl`, `apiKey` can also be passed per call as tool args.

## Behave like a collaborator

Users are often brief ("画只猫", "换个背景"). Expand that into a complete, concrete
prompt using the conversation and the canvas: subject, composition, setting, style,
lighting, color, mood, and any **in-image text quoted verbatim**. Keep every explicit
detail the user gave; fill in only what is missing. For the `prompt` argument passed to
`generate_seedream_image`, prefer **English** for provider and Windows compatibility
(translate the user's Chinese brief into English). Only keep Chinese in the prompt when
the user explicitly wants visible Chinese text inside the generated image, and quote that
visible text verbatim. After acting, say what you did and offer the next concrete step.

Never use the Cowart holder's default placeholder text as the image prompt. Placeholder
text includes phrases such as `What would you like to create?`, `Describe your image
request clearly!`, or mojibake/question-mark blocks (`????`). If you only see placeholder
text and cannot find the user's real image request in the conversation, ask the user for
the image description instead of calling the tool.

## Fill a selected AI 图片 holder (default)

When the user has selected one AI 图片 holder (a tldraw `frame`, or a legacy `geo`
rectangle, with `meta.cowartAiImageHolder: true`), call `generate_seedream_image` with
`placement: "into"` (the default when a holder is selected). The tool sizes the image
to the holder ratio (no crop or distortion) and fills the holder.

```json
{
  "prompt": "<full, detailed prompt; in-image text verbatim>",
  "placement": "into"
}
```

- By default the holder frame is replaced with a standalone image at the same position,
  so the user can move and resize it freely. Pass `keepHolder: true` to keep the frame
  and insert the image inside it instead.
- You may pass `holderShapeId` explicitly; otherwise the tool uses the single selected
  shape. You usually do not need to call `get_cowart_selection` first, but you may use
  it to confirm what is selected.

## Place beside an anchor (variants / annotation edits)

Use `placement: "right" | "left" | "below"` to size to the anchor ratio and place a new
image beside it **without changing the anchor**. This is the annotation-edit workflow:
keep the original and its annotations, add the revised image next to it.

```json
{ "prompt": "<what the result should be>", "placement": "right", "editSourceFromAnchor": true }
```

## Standalone image on the current page

With nothing selected, the tool places a standalone image on the current page. Give an
`aspectRatio` (width/height) or an explicit `size` for the shape you want.

```json
{ "prompt": "<prompt>", "aspectRatio": 1.7778 }
```

## Image-to-image

- `editSourceFromAnchor: true` uses the selected holder/anchor's existing local image as
  the source (best for "tweak this image" / annotation edits). Falls back to
  text-to-image if the anchor has no local image or the edit call fails.
- `sourceImagePath: "<absolute local path>"` uses a user-provided file (e.g. an exported
  annotation screenshot) as the source.
- `sourceImageUrl: "<url>"` uses a remote image as the source.

On Doubao this maps to the `image` field of `/images/generations`; on OpenAI-compatible
endpoints it uses `/images/edits` (JSON `images[image_url]`, multipart fallback).

## Sizing notes

- Doubao Seedream `WxH` sizes must total between `2560x1440` and `4096x4096` with aspect
  in `[1/16, 16]`; the tool snaps common ratios to recommended sizes (1:1 -> 2048x2048,
  16:9 -> 2560x1440, 3:2 -> 2496x1664, ...) and otherwise computes a legal `WxH`.
- You can override with `size` (explicit `2048x2048`, or a Doubao preset `1K`/`2K`/`4K`)
  or `targetPx`.

## Verify

After acting, refresh or let Cowart hot-reload, then confirm the new shape id, the saved
asset path, the provider/model used, and the final dimensions. For "into" placement,
confirm the holder is now filled (or replaced) in place; for beside placement, confirm
the original and any annotations are untouched.

## Guardrails

- Do not modify the Cowart plugin's files; this skill only talks to the running Cowart
  HTTP service and the project's `canvas/` data directory.
- Never overwrite an existing asset file; the tool always uses a timestamped filename.
- Never put the revised image inside the original frame for annotation edits (use a
  beside placement) so the before/after comparison stays clear.
- If the tool reports it cannot reach Cowart, ask the user to open the Cowart canvas
  first; if it reports a missing key, ask them to set it locally and restart Codex.
