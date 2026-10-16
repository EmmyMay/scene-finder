"""Regenerate the checked-in native icons with Python and Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

output = Path(__file__).resolve().parent.parent / "desktop" / "assets"
output.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (1024, 1024))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((60, 60, 964, 964), radius=206, fill="#242132")
draw.rounded_rectangle((224, 230, 800, 794), radius=94, fill="#B1A0E2")
draw.rectangle((340, 230, 374, 794), fill="#242132")
draw.rectangle((650, 230, 684, 794), fill="#242132")
for top in (354, 606):
    draw.rectangle((224, top, 340, top + 32), fill="#242132")
    draw.rectangle((684, top, 800, top + 32), fill="#242132")
draw.polygon(((449, 408), (449, 616), (603, 512)), fill="#242132")
image.save(output / "icon.png")
image.save(output / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
image.save(output / "icon.icns")
