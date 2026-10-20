#!/usr/bin/env python3
"""Generates the PWA icon set (gradient plate + beamed music note) with PIL only.

Run: python3 tools/make-icons.py
"""

import math
import os

from PIL import Image, ImageDraw

OUT = "/root/test/public/icons"
SS = 4  # supersampling factor
ACCENT = (124, 92, 255)
ACCENT_2 = (255, 77, 141)


def diagonal_gradient(size, start=ACCENT, end=ACCENT_2, angle=135):
    """Diagonal linear gradient as an RGB image."""
    base = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(base)
    rad = math.radians(angle)
    dx, dy = math.cos(rad), math.sin(rad)
    span = abs(dx) * size + abs(dy) * size

    for i in range(size * 2):
        t = i / (size * 2 - 1)
        color = tuple(round(start[c] + (end[c] - start[c]) * t) for c in range(3))
        cx, cy = size / 2 + dx * (i - size / 2), size / 2 + dy * (i - size / 2)
        draw.line(
            [(cx - dy * span, cy + dx * span), (cx + dy * span, cy - dx * span)],
            fill=color,
            width=2,
        )

    return base


def note_layer(size, color=(255, 255, 255, 255)):
    """Two beamed eighth notes, drawn supersampled then tilted slightly."""
    s = size * SS
    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    head_rx, head_ry = 0.098 * s, 0.078 * s
    stem_w = 0.042 * s
    stem_top = 0.215
    heads = [(0.34, 0.705), (0.70, 0.625)]

    for hx, hy in heads:
        cx, cy = hx * s, hy * s
        draw.ellipse([cx - head_rx, cy - head_ry, cx + head_rx, cy + head_ry], fill=color)
        x = cx + head_rx - stem_w * 0.85
        draw.rounded_rectangle([x, stem_top * s, x + stem_w, cy], radius=stem_w / 2, fill=color)

    x1 = heads[0][0] * s + head_rx - stem_w * 0.85
    x2 = heads[1][0] * s + head_rx - stem_w * 0.85 + stem_w
    top = stem_top * s
    draw.polygon(
        [(x1, top), (x2, top - 0.055 * s), (x2, top - 0.055 * s + 0.105 * s), (x1, top + 0.105 * s)],
        fill=color,
    )

    return layer.resize((size, size), Image.LANCZOS).rotate(-12, resample=Image.BICUBIC, expand=False)


def rounded_mask(size, radius_ratio=0.235):
    mask = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size * SS - 1, size * SS - 1], radius=size * SS * radius_ratio, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def plate_variant(size, *, maskable=False, radius_ratio=0.235):
    """Gradient plate (optionally rounded) with the note centred on it."""
    gradient = diagonal_gradient(size * SS).resize((size, size), Image.LANCZOS)
    base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    base.paste(gradient, (0, 0))
    base = Image.alpha_composite(base, Image.new("RGBA", (size, size), (6, 6, 10, 80)))

    note = note_layer(int(size * (0.58 if maskable else 0.74)))
    base.alpha_composite(note, ((size - note.width) // 2, (size - note.height) // 2))

    if not maskable:
        base.putalpha(rounded_mask(size, radius_ratio))

    return base


def apple_touch(size=180):
    icon = Image.new("RGB", (size, size), (11, 11, 15))
    icon.paste(diagonal_gradient(size * SS).resize((size, size), Image.LANCZOS), (0, 0))
    icon.paste(Image.new("RGB", (size, size), (6, 6, 10)), (0, 0), Image.new("L", (size, size), 40))
    note = note_layer(int(size * 0.66))
    icon.paste(note, ((size - note.width) // 2, (size - note.height) // 2), note)
    return icon


FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#ff4d8d"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#g)"/>
  <g fill="#ffffff" transform="rotate(-12 32 32)">
    <ellipse cx="24" cy="42.5" rx="6.3" ry="5"/>
    <rect x="28" y="14" width="2.8" height="28.5" rx="1.4"/>
    <ellipse cx="43" cy="37.5" rx="6.3" ry="5"/>
    <rect x="47" y="14" width="2.8" height="23.5" rx="1.4"/>
    <path d="M28 14 L49.8 10.5 L49.8 17.2 L28 20.7 Z"/>
  </g>
</svg>
"""

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)

    plate_variant(192).save(f"{OUT}/icon-192.png")
    plate_variant(512).save(f"{OUT}/icon-512.png")
    plate_variant(192, maskable=True).save(f"{OUT}/icon-maskable-192.png")
    plate_variant(512, maskable=True).save(f"{OUT}/icon-maskable-512.png")
    apple_touch(180).save(f"{OUT}/apple-touch-icon.png")

    with open(f"{OUT}/favicon.svg", "w", encoding="utf-8") as handle:
        handle.write(FAVICON)

    for name in sorted(os.listdir(OUT)):
        print(f"{name}: {os.path.getsize(os.path.join(OUT, name))} bytes")
