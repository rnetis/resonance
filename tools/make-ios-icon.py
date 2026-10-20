#!/usr/bin/env python3
"""Generates the iOS app icon (1024x1024, opaque, no rounded corners).

Reuses the artwork helpers from make-icons.py so the PWA and the native app
share one visual identity.

Run: python3 tools/make-ios-icon.py
"""

import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "ios", "Resonance", "Assets.xcassets", "AppIcon.appiconset", "AppIcon-1024.png")

spec = importlib.util.spec_from_file_location("make_icons", os.path.join(HERE, "make-icons.py"))
make_icons = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_icons)

from PIL import Image  # noqa: E402  (after the module load above)


def app_icon(size=1024):
    """Full-bleed gradient with the beamed note, opaque (iOS masks it itself)."""
    icon = make_icons.diagonal_gradient(size).convert("RGB")
    note = make_icons.note_layer(int(size * 0.66))
    icon.paste(note, ((size - note.width) // 2, (size - note.height) // 2), note)
    return icon


if __name__ == "__main__":
    icon = app_icon(1024)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    icon.save(OUT, "PNG")

    with Image.open(OUT) as check:
        print(f"{os.path.relpath(OUT, os.path.join(HERE, '..'))}: {check.size[0]}x{check.size[1]} mode={check.mode}")
