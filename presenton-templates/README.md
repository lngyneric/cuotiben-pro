# Presenton templates (wiki PPT agent)

## sysmex — the template generation uses

`sysmex/` is a copy of Presenton's stock `general` template (from the
`presenton-trial` container, Presenton 0.9.12-beta) with one change: the
Sysmex logo is embedded as a fixed decorative image at the top right of
every slide background (slot x=11.55in, y=0.12in, 1.48×0.52in — the
`PPT_LOGO_SLOT` in `src/modules/presentations/layouts.ts`).

The logo element (`sysmex_logo`, `fit: contain`, `decorative: true`) is in
all 12 background-component variants in `merged_components` and in the
inlined background copy of all 12 layouts (24 placements total). Presenton
treats `decorative: true` elements as fixed visual scaffolding that remains
unchanged, and logos are explicitly exempt from "replaceable" handling, so
generation never swaps the logo for another image.

`static/logo.png` is the repo's `public/logo.png` converted to a
transparent background (white → transparent by min-channel ramp; the mark
is dark blue + green, so it stays fully opaque). The original white-background
file is untouched. Everything else in `static/` is copied verbatim from
`general`.

## Why this exists

Before this, the wiki uploaded `logo.png` with **every** generation, and
Presenton ran its document parser (LiteParse OCR) on the image: job
`495f3eca` (2026-11-25) hung 600 seconds and never produced a deck. With the
logo in the template, generation uploads no logo at all — the wiki code no
longer calls `tryResolveLogo()` and the `presentations_generate` default
template is `sysmex` instead of `general`.

## Deploying

`/app/templates` inside the `presenton-trial` container is **not a volume**:
recreating the container wipes custom templates. This directory is the
source of truth; after any change, copy it into the container and restart
Presenton (templates are discovered at startup):

```bash
# run on idcaitool8svr, from the wiki worktree (/home/sysmex/cuotiben-pro-blog)
bash presenton-templates/deploy.sh
```

`deploy.sh` refuses to run while a wiki PPT job is generating/queued, copies
`sysmex/` into the container, verifies the files, restarts the container and
waits for it to answer again. If the container is ever recreated from the
image, just re-run the script.

## Rebuilding

```bash
# pull a fresh copy of the stock template from the container first
docker cp presenton-trial:/app/templates/general /tmp/general-template-dir
python3 presenton-templates/build-sysmex-template.py \
  --general-dir /tmp/general-template-dir \
  --logo public/logo.png \
  --out presenton-templates/sysmex
```

The builder checks the logo sha256 (`07b37baa…1cd44`), verifies every
`data:` reference resolves, and fails unless exactly 24 logo placements
were added. Re-running it is idempotent.

## If the logo changes

Replace `public/logo.png`, re-run the builder, re-run `deploy.sh`. If the new
logo has a different aspect ratio, update `PPT_LOGO_SLOT` in
`src/modules/presentations/layouts.ts` and the slot constants in
`build-sysmex-template.py` together.
