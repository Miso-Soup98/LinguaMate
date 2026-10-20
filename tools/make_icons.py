import struct
import zlib
from pathlib import Path


def png(width, height, pixel):
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw.extend(pixel(x, y, width, height))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
            chunk(b"IDAT", zlib.compress(bytes(raw), 9)),
            chunk(b"IEND", b""),
        ]
    )


def color(x, y, w, h):
    cx, cy = (w - 1) / 2, (h - 1) / 2
    r = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    radius = min(cx, cy) - 0.4
    if r > radius:
        return (0, 0, 0, 0)
    t = r / radius
    bg = (13, 148, 136, 255)
    edge = (6, 95, 90, 255)
    mix = t * t
    base = tuple(int(bg[i] * (1 - mix) + edge[i] * mix) for i in range(3)) + (255,)
    # two subtitle bars
    bar_w = w * 0.46
    bar_x = (w - bar_w) / 2
    y1, y2 = h * 0.38, h * 0.56
    hbar = max(1.2, h * 0.08)
    if bar_x <= x <= bar_x + bar_w and y1 <= y <= y1 + hbar:
        return (255, 255, 255, 255)
    if bar_x + w * 0.08 <= x <= bar_x + bar_w - w * 0.02 and y2 <= y <= y2 + hbar * 0.75:
        return (255, 237, 180, 235)
    return base


root = Path(__file__).resolve().parents[1] / "icons"
root.mkdir(exist_ok=True)
for size in (16, 32, 48, 128):
    (root / f"icon{size}.png").write_bytes(png(size, size, color))
print("icons ready")
