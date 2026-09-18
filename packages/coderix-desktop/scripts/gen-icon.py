#!/usr/bin/env python3
"""
Generate the Coderix app icon (a "lightning bolt" mark) as a 1024x1024 PNG.

Design:
  - Rounded-square background with a near-black -> deep-purple vertical gradient.
  - A bold purple/violet lightning bolt with a soft glow, lit from the top.

Only depends on Pillow (already available in the environment). Output is written
to assets/icon.png; build-dmg.sh turns that into assets/icon.icns via sips/iconutil.

Usage:
  python3 scripts/gen-icon.py
"""

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024

# --- background gradient (top -> bottom) ------------------------------------
BG_TOP = (10, 9, 20)       # #0a0914  near-black
BG_BOT = (40, 22, 80)      # #281450  deep purple


def vertical_gradient(top_rgb, bottom_rgb, size):
    mask = Image.linear_gradient("L").resize((size, size))  # 0 top -> 255 bottom
    top_img = Image.new("RGB", (size, size), top_rgb)
    bot_img = Image.new("RGB", (size, size), bottom_rgb)
    # Image.composite(a, b, mask): mask=0 -> b, mask=255 -> a
    return Image.composite(bot_img, top_img, mask).convert("RGBA")


def main():
    img = vertical_gradient(BG_TOP, BG_BOT, SIZE)

    # Rounded-square background tile, sized to ~83% (850×850) and centered, leaving a
    # small transparent margin. The bolt is sized relative to it (see `scale` below).
    tile = 850
    margin = (SIZE - tile) // 2          # 87
    radius = 187                         # ≈ 22% of tile (macOS squircle ratio)
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [margin, margin, margin + tile - 1, margin + tile - 1],
        radius=radius,
        fill=255,
    )
    img.putalpha(mask)

    # Lightning bolt polygon (conceptual 100x100 box, chunky classic bolt).
    bolt100 = [(50, 0), (18, 52), (46, 52), (34, 98), (66, 46), (44, 46)]
    scale = 6.664  # bolt ≈ 653px ≈ 64% of canvas (≈ 77% of the 850px tile height)
    tx, ty = 232, 186  # centers the bolt on the canvas
    pts = [(tx + x * scale, ty + y * scale) for (x, y) in bolt100]

    # --- soft purple glow behind the bolt -----------------------------------
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).polygon(
        [(x * 1.06, y * 1.06) for (x, y) in pts], fill=(168, 85, 247, 150)
    )
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    img = Image.alpha_composite(img, glow)

    # --- bolt body: near-white lavender top -> vivid purple bottom ----------
    bolt_tex = vertical_gradient((245, 243, 255), (147, 51, 234), SIZE)  # #f5f3ff -> #9333ea
    bolt_mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(bolt_mask).polygon(pts, fill=255)
    bolt = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bolt.paste(bolt_tex, (0, 0), bolt_mask)
    img = Image.alpha_composite(img, bolt)

    # --- inner hot core highlight -------------------------------------------
    core = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    core_mask = Image.new("L", (SIZE, SIZE), 0)
    inner = [(tx + 0.5 * scale + x * 0.55 * scale, ty + 0.10 * scale + y * 0.55 * scale)
             for (x, y) in bolt100]
    ImageDraw.Draw(core_mask).polygon(inner, fill=220)
    core.paste((255, 255, 255, 230), (0, 0), core_mask)
    core = core.filter(ImageFilter.GaussianBlur(4))
    img = Image.alpha_composite(img, core)

    out = "assets/icon.png"
    img.save(out, "PNG")
    print(f"[gen-icon] wrote {out} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
