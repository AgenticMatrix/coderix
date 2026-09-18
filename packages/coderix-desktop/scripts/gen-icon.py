#!/usr/bin/env python3
"""
Generate the Coderix app icon (a "lightning bolt" mark) as a 1024x1024 PNG.

Design:
  - Rounded-square background with a dark-indigo -> violet vertical gradient.
  - A bold amber/gold lightning bolt with a soft warm glow, lit from the top.

Only depends on Pillow (already available in the environment). Output is written
to assets/icon.png; build-dmg.sh turns that into assets/icon.icns via sips/iconutil.

Usage:
  python3 scripts/gen-icon.py
"""

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024

# --- background gradient (top -> bottom) ------------------------------------
BG_TOP = (19, 15, 54)      # #130f36  dark indigo
BG_BOT = (124, 58, 237)    # #7c3aed  violet


def vertical_gradient(top_rgb, bottom_rgb, size):
    mask = Image.linear_gradient("L").resize((size, size))  # 0 top -> 255 bottom
    top_img = Image.new("RGB", (size, size), top_rgb)
    bot_img = Image.new("RGB", (size, size), bottom_rgb)
    # Image.composite(a, b, mask): mask=0 -> b, mask=255 -> a
    return Image.composite(bot_img, top_img, mask).convert("RGBA")


def main():
    img = vertical_gradient(BG_TOP, BG_BOT, SIZE)

    # Rounded-square corners (macOS will apply its own squircle mask too).
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=200, fill=255)
    img.putalpha(mask)

    # Lightning bolt polygon (conceptual 100x100 box, chunky classic bolt).
    bolt100 = [(50, 0), (18, 52), (46, 52), (34, 98), (66, 46), (44, 46)]
    scale = 8.33
    tx, ty = 162, 104  # centers the bolt on the canvas
    pts = [(tx + x * scale, ty + y * scale) for (x, y) in bolt100]

    # --- soft warm glow behind the bolt -------------------------------------
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ImageDraw.Draw(glow).polygon(
        [(x * 1.06, y * 1.06) for (x, y) in pts], fill=(251, 191, 36, 150)
    )
    glow = glow.filter(ImageFilter.GaussianBlur(60))
    img = Image.alpha_composite(img, glow)

    # --- bolt body: near-white top -> amber bottom --------------------------
    bolt_tex = vertical_gradient((255, 250, 235), (245, 158, 11), SIZE)  # #fffaeb -> #f59e0b
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
