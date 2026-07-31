#!/usr/bin/env python3
"""#334 — six built-in backgrounds, generated procedurally so the contrast
constraint is MEASURED, not hoped for.

cic composites the wallpaper at `opacity: var(--theme-bg-opacity, .3)` over the
scrollback pane (`--bg` #0a0a0a dark / #ffffff light), and the user can drag
that slider to 1.0. So the legibility contract is on the COMPOSITE:

  * whole image holds 4.5:1 up to alpha 0.6 (2x the default)
  * central reading band holds 4.5:1 all the way to alpha 1.0
  * detail lives at the edges, the middle stays calm

Text: #e0e0e0 on dark, #000000 on light (themes/default.css).
"""
import math
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1920, 1072
OUT = os.environ.get("BG_OUT", "cicchetto/public/backgrounds")
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_B = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

# ---------------------------------------------------------------- colour math
def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)

def rel_lum(rgb):
    """rgb: float array (...,3) in 0..255 -> relative luminance 0..1"""
    lin = srgb_to_lin(rgb)
    return 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]

def contrast(l1, l2):
    hi, lo = np.maximum(l1, l2), np.minimum(l1, l2)
    return (hi + 0.05) / (lo + 0.05)

L_TEXT_DARK = rel_lum(np.array([224.0, 224.0, 224.0]))   # #e0e0e0
L_TEXT_LIGHT = rel_lum(np.array([0.0, 0.0, 0.0]))        # #000000
PANE_DARK, PANE_LIGHT = 10.0, 255.0                      # #0a0a0a / #ffffff

# Aim the envelope at 4.6, not 4.5: an image that lands EXACTLY on the bar is
# one float rounding away from failing it (the phosphor band did precisely that
# at 4.4996). The margin is the difference between a gate and a coin toss.
TARGET = 4.6

def max_img_value(alpha, pane):
    """Greatest neutral image value whose composite still clears TARGET (dark)."""
    lo, hi = 0.0, 255.0
    for _ in range(60):
        mid = (lo + hi) / 2
        eff = pane * (1 - alpha) + mid * alpha
        if contrast(rel_lum(np.array([eff] * 3)), L_TEXT_DARK) >= TARGET:
            lo = mid
        else:
            hi = mid
    return lo

def min_img_value(alpha, pane):
    """Smallest neutral image value whose composite still clears TARGET (light)."""
    lo, hi = 0.0, 255.0
    for _ in range(60):
        mid = (lo + hi) / 2
        eff = pane * (1 - alpha) + mid * alpha
        if contrast(rel_lum(np.array([eff] * 3)), L_TEXT_LIGHT) >= TARGET:
            hi = mid
        else:
            lo = mid
    return hi

DARK_EDGE_CAP = max_img_value(0.6, PANE_DARK)     # whole image @ alpha .6
DARK_CENTRE_CAP = max_img_value(1.0, PANE_DARK)   # reading band @ alpha 1
LIGHT_EDGE_FLOOR = min_img_value(0.6, PANE_LIGHT)
LIGHT_CENTRE_FLOOR = min_img_value(1.0, PANE_LIGHT)

def centre_weight():
    """1.0 in the reading band, easing to 0 at the edges (smoothstep)."""
    y = np.linspace(-1, 1, H)[:, None]
    x = np.linspace(-1, 1, W)[None, :]
    # the band is wide horizontally (text spans the pane) and softer vertically
    d = np.sqrt((x / 1.35) ** 2 + (y / 0.92) ** 2)
    t = np.clip(1.0 - (d - 0.10) / 0.75, 0.0, 1.0)
    return t * t * (3 - 2 * t)

CW = centre_weight()

# The verification band is `CW > 0.75`, so the envelope must already be AT the
# centre cap by the time CW reaches 0.75 — otherwise the ramp quietly allows
# more light inside the very band whose contract it is meant to guarantee (the
# phosphor image caught exactly this). Redefining the band to fit the ramp would
# be moving the goalposts; the ramp is what has to honour the promise.
BAND = np.clip(CW / 0.75, 0.0, 1.0)

def enforce_dark(arr):
    """Scale any pixel that exceeds its allowed luminance, preserving hue."""
    cap_lum = np.empty((H, W))
    caps = DARK_CENTRE_CAP * BAND + DARK_EDGE_CAP * (1 - BAND)
    for i in range(0, H, 64):  # chunked to keep peak memory sane on the Pi
        sl = slice(i, min(i + 64, H))
        cap_lum[sl] = rel_lum(np.repeat(caps[sl][..., None], 3, axis=-1))
    lum = rel_lum(arr)
    over = lum > cap_lum
    if over.any():
        lin = srgb_to_lin(arr)
        scale = np.ones_like(lum)
        np.divide(cap_lum, np.maximum(lum, 1e-9), out=scale, where=over)
        lin = lin * scale[..., None]
        arr = lin_to_srgb(lin)
    return arr

def enforce_light(arr):
    """Blend toward white until every pixel clears its luminance floor."""
    floors = LIGHT_CENTRE_FLOOR * BAND + LIGHT_EDGE_FLOOR * (1 - BAND)
    floor_lum = np.empty((H, W))
    for i in range(0, H, 64):
        sl = slice(i, min(i + 64, H))
        floor_lum[sl] = rel_lum(np.repeat(floors[sl][..., None], 3, axis=-1))
    for _ in range(24):                       # converges in a handful of passes
        lum = rel_lum(arr)
        under = lum < floor_lum
        if not under.any():
            break
        k = np.zeros_like(lum)
        np.divide(floor_lum - lum, np.maximum(1.0 - lum, 1e-9), out=k, where=under)
        k = np.clip(k * 1.05, 0, 1)[..., None]
        arr = arr * (1 - k) + 255.0 * k
    return arr

def lin_to_srgb(lin):
    lin = np.clip(lin, 0, 1)
    s = np.where(lin <= 0.0031308, lin * 12.92, 1.055 * lin ** (1 / 2.4) - 0.055)
    return s * 255.0

def save(arr, name, variant):
    arr = enforce_dark(arr) if variant == "dark" else enforce_light(arr)
    arr = np.clip(arr, 0, 255)
    img = Image.fromarray(arr.astype(np.uint8), "RGB")
    path = f"{OUT}/{name}.webp"
    img.save(path, "WEBP", quality=88, method=6)
    return path, arr

# ------------------------------------------------------------------ 09 matrix
def covered(font, chars):
    """Keep only glyphs the font actually draws — the Pi has no CJK font, and
    an uncovered codepoint renders as a tofu box, which is what the first cut
    of this image did with katakana. Verify, do not assume."""
    from PIL import Image as _I, ImageDraw as _D
    ok = []
    for ch in chars:
        im = _I.new("L", (40, 40), 0)
        _D.Draw(im).text((6, 2), ch, font=font, fill=255)
        if im.getbbox() is not None:
            ok.append(ch)
    return ok

def matrix():
    rng = np.random.default_rng(334_09)
    img = Image.new("RGB", (W, H), (2, 6, 3))
    d = ImageDraw.Draw(img)
    # three depth layers: far/small/dim -> near/large/bright
    layers = [(15, 20, 0.42), (19, 24, 0.68), (24, 30, 1.0)]
    pool = "0123456789ABCDEFXYZ<>[]{}/\\|=+*#$%&@!?;:~^ΔΣΩΨΞλπµ"
    for size, step, punch in layers:
        f = ImageFont.truetype(MONO, size)
        glyphs = covered(f, pool)
        for cx in range(0, W, step):
            # edges dense and bright, middle thins to almost nothing
            edge = min(abs(cx - W / 2) / (W / 2) * 1.2, 1.0)
            if rng.random() > 0.30 + 0.66 * edge:
                continue
            head = int(rng.integers(-500, H))
            length = int(rng.integers(14, 40))
            for k in range(length):
                y = head - k * step
                if not (-30 < y < H):
                    continue
                fade = (1 - k / length) ** 1.45
                g = int(24 + 200 * fade * punch * (0.32 + 0.68 * edge))
                if k == 0:                                  # bright leading glyph
                    g = min(235, int(g * 1.5) + 40)
                d.text((cx, y), glyphs[rng.integers(len(glyphs))],
                       font=f, fill=(int(g * 0.16), g, int(g * 0.40)))
    img = img.filter(ImageFilter.GaussianBlur(0.45))
    a = np.asarray(img).astype(np.float64)
    yy = np.linspace(0, 1, H)[:, None, None]
    a = a * (0.58 + 0.42 * yy)                   # top darker, rain fades in
    return a

# --------------------------------------------------------------- 10 cyberpunk
def cyberpunk():
    rng = np.random.default_rng(334_10)
    y = np.linspace(0, 1, H)[:, None]
    x = np.linspace(0, 1, W)[None, :]
    sky = np.zeros((H, W, 3))
    sky[..., 0] = 26 + 44 * (1 - y) + 16 * np.sin(x * 3.1)
    sky[..., 1] = 6 + 12 * (1 - y)
    sky[..., 2] = 40 + 60 * (1 - y) + 20 * np.cos(x * 2.3)
    img = Image.fromarray(np.clip(sky, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img)
    # skyline: tall at the edges, low across the middle so the centre stays calm
    for band, (depth, tint) in enumerate([(0.55, (18, 8, 34)), (0.8, (10, 5, 22))]):
        cx = 0
        while cx < W:
            w = int(rng.integers(48, 150))
            edge = min(abs(cx + w / 2 - W / 2) / (W / 2), 1.0)
            top = H - int((90 + 430 * edge ** 1.5 * depth) * rng.uniform(0.7, 1.15))
            d.rectangle([cx, top, cx + w, H], fill=tint)
            neon = (255, 60, 140) if rng.random() < 0.5 else (60, 210, 255)
            for _ in range(int(rng.integers(6, 26))):
                wx = cx + int(rng.integers(6, max(7, w - 6)))
                wy = int(rng.integers(top + 8, H - 8))
                if rng.random() < 0.30 + 0.5 * edge:
                    d.rectangle([wx, wy, wx + 3, wy + 6], fill=neon)
            if rng.random() < 0.35:
                d.line([cx + 4, top, cx + w - 4, top], fill=neon, width=2)
            cx += w + int(rng.integers(4, 26))
    img = img.filter(ImageFilter.GaussianBlur(1.5))
    return np.asarray(img).astype(np.float64)

# --------------------------------------------------------------- 11 phosphor
def phosphor():
    rng = np.random.default_rng(334_11)
    img = Image.new("RGB", (W, H), (1, 7, 2))
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(MONO, 19)
    lines = [
        "*** GRAPPA BOUNCER v0.8 — CRT TERMINAL ***", "READY.", "LOAD \"IRC\",8,1",
        "SEARCHING FOR IRC", "LOADING", "OK", "RUN", "CONNECT 2400/ARQ/V.42BIS",
        "-!- Irssi: Looking up irc.azzurra.chat", "-!- Irssi: Connection established",
        "MEMORY: 38911 BASIC BYTES FREE", "SYNTAX ERROR", "PRESS PLAY ON TAPE",
    ]
    for row in range(0, H, 30):
        edge = min(abs(row - H / 2) / (H / 2) * 1.2, 1.0)
        if rng.random() > 0.18 + 0.75 * edge:
            continue
        txt = lines[rng.integers(len(lines))]
        xoff = int(rng.integers(20, 220)) + (0 if rng.random() < 0.6 else W // 2)
        g = int(90 + 130 * (0.35 + 0.65 * edge))
        d.text((xoff, row), txt, font=f, fill=(int(g * 0.16), g, int(g * 0.30)))
    img = img.filter(ImageFilter.GaussianBlur(0.7))
    a = np.asarray(img).astype(np.float64)
    rows = np.arange(H)[:, None, None]
    a = a * (0.72 + 0.28 * (rows % 3 != 0))       # scanlines
    yy = np.linspace(-1, 1, H)[:, None]
    xx = np.linspace(-1, 1, W)[None, :]
    a = a * (1.0 - 0.45 * np.clip((xx ** 2 + yy ** 2) / 2.2, 0, 1))[..., None]  # CRT vignette
    return a

# --------------------------------------------------------------- 12 xp hills
def xp_hills():
    y = np.linspace(0, 1, H)[:, None]
    x = np.linspace(0, 1, W)[None, :]
    a = np.zeros((H, W, 3))
    # heavily desaturated sky: pale, almost paper
    a[..., 0] = 214 + 24 * (1 - y)
    a[..., 1] = 220 + 22 * (1 - y)
    a[..., 2] = 228 + 20 * (1 - y)
    for i, (base, amp, phase, tone) in enumerate(
        [(0.70, 0.05, 0.0, (196, 205, 190)), (0.80, 0.04, 1.7, (183, 195, 176))]
    ):
        ridge = base + amp * np.sin(x * (2.1 + i) * math.pi + phase)
        mask = (y > ridge).astype(np.float64)
        mask = np.repeat(mask[..., None], 3, axis=-1)
        a = a * (1 - mask) + np.array(tone) * mask
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    img = img.filter(ImageFilter.GaussianBlur(2.5))   # subjects blurred as ambience
    return np.asarray(img).astype(np.float64)

# --------------------------------------------------------------- 13 system 7
def system7():
    # classic 50% ordered dither — the System 7 desktop pattern. Kept a touch
    # wider than 208/246 so the texture survives being scaled down in the
    # picker; still far above the light floor.
    bayer = np.array([[0, 8, 2, 10], [12, 4, 14, 6],
                      [3, 11, 1, 9], [15, 7, 13, 5]]) / 16.0
    tile = np.tile(bayer, (H // 4 + 1, W // 4 + 1))[:H, :W]
    a = np.where(tile < 0.5, 198.0, 248.0)
    a = np.repeat(a[..., None], 3, axis=-1)
    a[..., 2] *= 1.01                                  # a hair cool, like the CRT
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(MONO_B, 15)

    def window(bx, by, bw, bh, title):
        d.rectangle([bx, by, bx + bw, by + bh], fill=(252, 252, 252),
                    outline=(70, 70, 70), width=2)
        d.rectangle([bx, by, bx + bw, by + 24], fill=(246, 246, 246),
                    outline=(70, 70, 70), width=2)
        # measure, never assume: the first cut hard-coded a box width and
        # sliced the titles to "System Fo" / "About Thi".
        l, t, r, bo = f.getbbox(title)
        tw, th = r - l, bo - t
        tx = bx + (bw - tw) // 2
        ty = by + (24 - th) // 2 - t
        d.rectangle([tx - 8, by + 3, tx + tw + 8, by + 21], fill=(246, 246, 246))
        d.text((tx, ty), title, font=f, fill=(40, 40, 40))
        for ly in range(by + 6, by + 20, 4):           # the striped title bar
            d.line([bx + 8, ly, tx - 12, ly], fill=(110, 110, 110))
            d.line([tx + tw + 12, ly, bx + bw - 26, ly], fill=(110, 110, 110))
        d.rectangle([bx + 6, by + 6, bx + 18, by + 18],  # close box
                    fill=(252, 252, 252), outline=(70, 70, 70), width=1)

    # chrome parked at the edges only — the reading band stays empty
    window(70, 90, 430, 250, "System Folder")
    window(W - 520, H - 330, 440, 250, "Chooser")
    window(W - 400, 120, 330, 170, "About This Macintosh")
    img = img.filter(ImageFilter.GaussianBlur(0.3))
    return np.asarray(img).astype(np.float64)

# --------------------------------------------------------------- 14 blueprint
def blueprint():
    rng = np.random.default_rng(334_14)
    a = np.full((H, W, 3), 240.0)
    a[..., 0] = 232.0
    a[..., 1] = 238.0
    a[..., 2] = 246.0                                  # pale drafting paper
    img = Image.fromarray(a.astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img)
    fine, bold = (188, 203, 224), (150, 172, 205)
    for gx in range(0, W, 24):
        d.line([gx, 0, gx, H], fill=bold if gx % 120 == 0 else fine, width=1)
    for gy in range(0, H, 24):
        d.line([0, gy, W, gy], fill=bold if gy % 120 == 0 else fine, width=1)
    ink = (118, 146, 188)
    # technical linework parked around the border, centre left clean
    for (cx, cy, r) in [(250, 240, 130), (W - 300, H - 260, 150), (W - 240, 250, 95),
                        (300, H - 220, 110)]:
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ink, width=2)
        d.ellipse([cx - r // 2, cy - r // 2, cx + r // 2, cy + r // 2], outline=ink, width=1)
        d.line([cx - r - 30, cy, cx + r + 30, cy], fill=ink, width=1)
        d.line([cx, cy - r - 30, cx, cy + r + 30], fill=ink, width=1)
        for ang in range(0, 360, 30):
            t = math.radians(ang)
            d.line([cx + (r - 12) * math.cos(t), cy + (r - 12) * math.sin(t),
                    cx + r * math.cos(t), cy + r * math.sin(t)], fill=ink, width=1)
    for _ in range(14):
        bx = int(rng.choice([rng.integers(40, 520), rng.integers(W - 560, W - 120)]))
        by = int(rng.choice([rng.integers(40, 300), rng.integers(H - 340, H - 90)]))
        bw, bh = int(rng.integers(70, 200)), int(rng.integers(50, 150))
        d.rectangle([bx, by, bx + bw, by + bh], outline=ink, width=1)
        d.line([bx, by, bx + bw, by + bh], fill=ink, width=1)
    d.rectangle([28, 28, W - 28, H - 28], outline=(120, 148, 190), width=3)
    img = img.filter(ImageFilter.GaussianBlur(0.5))
    return np.asarray(img).astype(np.float64)

# -------------------------------------------------------------------- verify
def verify(name, arr, variant):
    lum = rel_lum(arr)
    band = CW > 0.75
    rows = []
    for alpha in (0.3, 0.6, 1.0):
        pane = PANE_DARK if variant == "dark" else PANE_LIGHT
        eff = pane * (1 - alpha) + arr * alpha
        le = rel_lum(eff)
        lt = L_TEXT_DARK if variant == "dark" else L_TEXT_LIGHT
        c_all = contrast(le, lt).min()
        c_band = contrast(le[band], lt).min()
        rows.append((alpha, c_all, c_band))
    return lum, rows

SPECS = [
    ("09-matrix-dark", "dark", matrix),
    ("10-cyberpunk-dark", "dark", cyberpunk),
    ("11-phosphor-dark", "dark", phosphor),
    ("12-xp-hills-light", "light", xp_hills),
    ("13-system7-light", "light", system7),
    ("14-blueprint-light", "light", blueprint),
]

if __name__ == "__main__":
    print(f"dark caps   : edge<= {DARK_EDGE_CAP:.1f}  centre<= {DARK_CENTRE_CAP:.1f}")
    print(f"light floors: edge>= {LIGHT_EDGE_FLOOR:.1f}  centre>= {LIGHT_CENTRE_FLOOR:.1f}\n")
    for name, variant, fn in SPECS:
        arr = fn()
        path, arr = save(arr, name, variant)
        lum, rows = verify(name, arr, variant)
        kb = os.path.getsize(path) // 1024
        print(f"{name:22s} {variant:5s} {kb:4d}KB  Lmean={lum.mean():.3f}")
        for alpha, c_all, c_band in rows:
            flag = "OK " if (c_band >= 4.5 and (alpha > 0.6 or c_all >= 4.5)) else "!! "
            print(f"    {flag}alpha={alpha:.1f}  worst-all={c_all:5.2f}  worst-band={c_band:5.2f}")
