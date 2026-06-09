#!/usr/bin/env python3
"""Turn a source photo into glitchy JD Samps extension icons.

Usage:
    python3 make_icon.py /path/to/photo.jpg

Crops the person to a square, applies a glitch effect (RGB channel split,
slice displacement, scanlines, noise blocks), stamps "JD Samps", and writes
icons/icon16.png, icon48.png, icon128.png (+ a 256px preview).
"""
import sys, os, random
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageChops

random.seed(7)  # deterministic glitch
MASTER = 256

def load_font(size):
    for p in [
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()

def square_crop_person(img):
    """Center-horizontal, top-biased square crop so the face is kept."""
    img = img.convert("RGB")
    w, h = img.size
    s = min(w, h)
    left = (w - s) // 2
    top = int((h - s) * 0.18)  # bias upward toward the face
    top = max(0, min(top, h - s))
    return img.crop((left, top, left + s, top + s)).resize((MASTER, MASTER), Image.LANCZOS)

def rgb_shift(img, dx=6):
    r, g, b = img.split()
    r = ImageChops.offset(r, dx, -2)
    b = ImageChops.offset(b, -dx, 2)
    return Image.merge("RGB", (r, g, b))

def slice_glitch(img, n=14, maxshift=22):
    out = img.copy()
    w, h = img.size
    for _ in range(n):
        y = random.randint(0, h - 1)
        sh = random.randint(2, max(3, h // 22))
        band = img.crop((0, y, w, min(h, y + sh)))
        dx = random.randint(-maxshift, maxshift)
        out.paste(ImageChops.offset(band, dx, 0), (0, y))
    return out

def scanlines(img, darken=0.82):
    px = img.load()
    w, h = img.size
    for y in range(0, h, 2):
        for x in range(w):
            r, g, b = px[x, y]
            px[x, y] = (int(r * darken), int(g * darken), int(b * darken))
    return img

def noise_blocks(img, n=8):
    d = ImageDraw.Draw(img, "RGBA")
    w, h = img.size
    cols = [(74, 222, 128, 150), (244, 63, 94, 130), (96, 165, 250, 130), (255, 255, 255, 110)]
    for _ in range(n):
        bx = random.randint(0, w - 10)
        by = random.randint(0, h - 6)
        bw = random.randint(10, 60)
        bh = random.randint(2, 7)
        d.rectangle([bx, by, bx + bw, by + bh], fill=random.choice(cols))
    return img

def add_text(img):
    d = ImageDraw.Draw(img)
    f = load_font(int(MASTER * 0.20))
    txt = "JD Samps"
    bbox = d.textbbox((0, 0), txt, font=f)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (MASTER - tw) // 2 - bbox[0]
    y = int(MASTER * 0.70)
    # backing bar for legibility
    d.rectangle([0, y - 8, MASTER, y + th + 10], fill=(10, 12, 16))
    # chromatic ghosts
    d.text((x - 3, y + 1), txt, font=f, fill=(244, 63, 94))
    d.text((x + 3, y - 1), txt, font=f, fill=(96, 165, 250))
    d.text((x, y), txt, font=f, fill=(74, 222, 128))
    return img

def build(src):
    img = square_crop_person(Image.open(src))
    img = ImageEnhance.Contrast(img).enhance(1.18)
    img = ImageEnhance.Color(img).enhance(1.25)
    img = rgb_shift(img, dx=6)
    img = slice_glitch(img)
    img = noise_blocks(img)
    img = scanlines(img)
    img = add_text(img)
    return img

def main():
    if len(sys.argv) < 2:
        print("usage: python3 make_icon.py /path/to/photo.jpg")
        sys.exit(1)
    src = os.path.expanduser(sys.argv[1])
    if not os.path.exists(src):
        print("file not found:", src)
        sys.exit(1)
    os.makedirs("icons", exist_ok=True)
    master = build(src)
    master.save("icons/icon256.png")
    for s in (128, 48, 16):
        master.resize((s, s), Image.LANCZOS).save(f"icons/icon{s}.png")
    print("wrote icons/icon{16,48,128,256}.png")

if __name__ == "__main__":
    main()
