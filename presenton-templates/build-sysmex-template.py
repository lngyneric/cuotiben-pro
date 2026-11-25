#!/usr/bin/env python3
"""Build the `sysmex` Presenton template from the stock `general` template.

The sysmex template is `general` (Presenton 0.9.12-beta) plus the Sysmex logo
embedded as a fixed decorative image on every slide background, so generation
never needs to upload logo.png again (uploading it made Presenton run its
document parser/LiteParse OCR on the image and hang for 600s — job 495f3eca,
2026-11-25).

Usage:
    python3 build-sysmex-template.py --general-dir /path/to/general \
        --logo ../../public/logo.png --out ./sysmex

- --general-dir: a copy of /app/templates/general from the presenton-trial
  container (`docker cp presenton-trial:/app/templates/general ...`).
- --logo: the raster logo (public/logo.png, 275x110, sha256 07b37baa...1cd44).
  It is converted to transparent-background RGBA for the template (the
  source file is white-background RGB; the mark is dark blue + green, so a
  min-channel ramp 210->248 to alpha makes the white transparent while
  keeping every mark pixel opaque). The wiki keeps the original file.
- --out: destination directory (created/overwritten).

What it changes (nothing else):
  * template.json: id/name/description -> sysmex; a `sysmex_logo` image element
    is appended to every background component (full-canvas white polygon):
    all variants of the merged background components AND the inlined
    background copy in each of the 12 layouts. The element is
    decorative=true, so Presenton's certified generation treats it as fixed
    visual scaffolding that remains unchanged (logos are explicitly exempt
    from "replaceable" handling); fit=contain so the logo is never cropped.
  * static/logo.png: copy of the logo. static/ is otherwise copied verbatim
    from general (all `data:` references keep resolving).

Logo slot (from the wiki theme registry, layouts.ts PPT_LOGO_SLOT):
  x=11.55in, y=0.12in, 1.48x0.52in on a 13.33x7.5in slide (1280x720px @96dpi)
  -> x=1109, y=12, w=142, h=50 px.

Idempotent: re-running skips components that already carry sysmex_logo.
"""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

LOGO_SHA256 = "07b37baaf8e58be74aac3536135ca85e7fe1a68c205fc9b8a22ef40a3251cd44"
# 96 px per inch on the 1280x720 canvas.
LOGO = {
    "type": "image",
    "position": {"x": 1109, "y": 12},
    "size": {"width": 142, "height": 50},
    "rotation": 0,
    "data": "static/logo.png",
    "fit": "contain",
    "decorative": True,
    "name": "sysmex_logo",
    "is_icon": False,
}
LOGO_RECT = (1109, 12, 1109 + 142, 12 + 50)


def is_background(elements):
    """First element is a vector polygon covering the full 1280x720 canvas."""
    if not elements:
        return False
    e0 = elements[0]
    if e0.get("type") != "vector":
        return False
    pts = e0.get("points") or []
    if len(pts) < 4:
        return False
    xs = [p["x"] for p in pts]
    ys = [p["y"] for p in pts]
    return min(xs) == 0 and max(xs) == 1280 and min(ys) == 0 and max(ys) == 720


def bbox(el):
    pos = el.get("position") or {}
    size = el.get("size") or {}
    x, y = pos.get("x", 0), pos.get("y", 0)
    w, h = size.get("width", 0), size.get("height", 0)
    return (x, y, x + w, y + h)


def intersects(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def add_logo(elements, where, warnings):
    if any(e.get("name") == "sysmex_logo" for e in elements):
        return False
    for e in elements:
        r = bbox(e)
        if e.get("type") != "vector" and intersects(r, LOGO_RECT):
            # Expected: the logo is transparent and painted last (on top), so
            # sitting over an accent/photo is fine. Kept as a note, not an error.
            warnings.append(f"{where}: logo floats over {e.get('type')} "
                            f"'{e.get('name')}' (transparent, on top — by design)")
    elements.append(dict(LOGO))
    return True


def logo_to_transparent(png_bytes):
    """White-background RGB logo -> transparent-background RGBA.

    Alpha comes from the min channel: saturated mark pixels (dark blue /
    green diamonds, min channel < 210) stay fully opaque; near-white pixels
    (min channel > 248) become fully transparent; anti-aliased edge pixels
    ramp linearly in between, so edges stay smooth over any background.
    """
    from PIL import Image
    import io
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    px = im.load()
    out = Image.new("RGBA", im.size)
    opx = out.load()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b = px[x, y]
            m = min(r, g, b)
            if m >= 248:
                a = 0
            elif m <= 210:
                a = 255
            else:
                a = round(255 * (248 - m) / (248 - 210))
            opx[x, y] = (r, g, b, a)
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--general-dir", required=True)
    ap.add_argument("--logo", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    general_dir = Path(args.general_dir)
    logo_path = Path(args.logo)
    out = Path(args.out)

    logo_bytes = logo_path.read_bytes()
    digest = hashlib.sha256(logo_bytes).hexdigest()
    if digest != LOGO_SHA256:
        print(f"ERROR: logo sha256 {digest} != expected {LOGO_SHA256}", file=sys.stderr)
        return 1

    tpl = json.loads((general_dir / "template.json").read_text())
    if tpl.get("id") != "general":
        print(f"ERROR: expected general template, got id={tpl.get('id')!r}", file=sys.stderr)
        return 1
    tpl["id"] = "sysmex"
    tpl["name"] = "Sysmex"
    tpl["description"] = (
        "Sysmex template (based on General): the Sysmex logo is embedded in the "
        "template at the top right of every slide, so generation never uploads it."
    )

    warnings = []
    added = 0
    # 1. Merged background components (the LLM's component library).
    for comp in tpl.get("merged_components", []):
        for vi, variant in enumerate(comp.get("variants", [])):
            els = variant.get("elements", [])
            if is_background(els):
                if add_logo(els, f"merged/{comp['id']} v{vi}", warnings):
                    added += 1
    # 2. Inlined background copy in each layout (what actually renders).
    for lay in tpl.get("layouts", []):
        comps = lay.get("components", [])
        if comps and is_background(comps[0].get("elements", [])):
            if add_logo(comps[0]["elements"], f"layout/{lay['id']}", warnings):
                added += 1

    # 3. Validate: every template-relative data: reference (static/...)
    # resolves inside static/. Leading-slash refs (/static/images/...) are
    # server-rooted (e.g. replaceable_template_image.png lives in the
    # Presenton server's own static dir, not in the template) — skip those.
    static_dir = general_dir / "static"
    missing = set()

    def check(obj):
        if isinstance(obj, dict):
            if isinstance(obj.get("data"), str) and obj["data"].startswith("static/"):
                p = static_dir / obj["data"][len("static/"):]
                if not p.exists() and obj["data"] != "static/logo.png":
                    missing.add(obj["data"])
            for v in obj.values():
                check(v)
        elif isinstance(obj, list):
            for v in obj:
                check(v)

    check(tpl)
    if missing:
        print(f"ERROR: missing static files: {sorted(missing)}", file=sys.stderr)
        return 1

    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(static_dir, out / "static")
    (out / "static" / "logo.png").write_bytes(logo_to_transparent(logo_bytes))
    (out / "template.json").write_text(json.dumps(tpl, indent=2, ensure_ascii=False) + "\n")

    print(f"logo elements added: {added} (expect 12 merged variants + 12 layouts = 24)")
    for w in warnings:
        print("WARNING:", w)
    if added != 24:
        print(f"ERROR: expected 24 logo placements, got {added}", file=sys.stderr)
        return 1
    print(f"wrote {out}/template.json + {out}/static/ ({len(list((out/'static').rglob('*')))} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
