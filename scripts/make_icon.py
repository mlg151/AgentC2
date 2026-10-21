"""Generate platform icons from the existing AgentC2 vector-like design."""

from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
target = root / "assets" / "app-icon.ico"
target.parent.mkdir(parents=True, exist_ok=True)

image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((18, 18, 494, 494), radius=86, fill="#142a33", outline="#32858b", width=18)
draw.rounded_rectangle((55, 55, 457, 457), radius=48, fill="#0b1c24")
draw.line(((142, 143), (244, 255), (142, 367)), fill="#4ce0df", width=34, joint="curve")
draw.line(((263, 363), (378, 363)), fill="#4ce0df", width=34)
draw.ellipse((356, 348, 390, 382), fill="#4ce0df")
image.save(root / "assets" / "app-icon.png")
image.resize((1024, 1024), Image.Resampling.LANCZOS).save(root / "assets" / "app-icon.icns", format="ICNS")
image.save(target, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print(target)

# macOS template images use only their alpha channel; @2x preserves Retina detail.
for scale in (1, 2):
    tray = Image.new("RGBA", (22 * scale, 22 * scale), (0, 0, 0, 0))
    pen = ImageDraw.Draw(tray)
    pen.line([(4 * scale, 5 * scale), (10 * scale, 11 * scale), (4 * scale, 17 * scale)], fill="black", width=2 * scale)
    pen.line([(12 * scale, 17 * scale), (19 * scale, 17 * scale)], fill="black", width=2 * scale)
    suffix = "@2x" if scale == 2 else ""
    tray.save(root / "assets" / f"trayTemplate{suffix}.png")
