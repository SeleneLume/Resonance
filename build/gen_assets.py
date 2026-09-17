import math, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

random.seed(7)

# ---------- palette (soft kawaii pastel: lavender -> pink -> baby blue) ----------
def lerp(a, b, t):
    return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

STOP_A = (168, 145, 235)   # soft lavender
STOP_B = (240, 170, 210)   # soft pink
STOP_C = (170, 210, 245)   # soft baby blue

def gradient(w, h, diagonal=True):
    img = Image.new('RGB', (w, h))
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = ((x / w) + (y / h)) / 2 if diagonal else (y / h)
            if t < 0.5:
                c = lerp(STOP_A, STOP_B, t * 2)
            else:
                c = lerp(STOP_B, STOP_C, (t - 0.5) * 2)
            px[x, y] = c
    return img

def draw_star(draw, cx, cy, r, fill, points=4):
    # four/five point sparkle star (like a plus with concave sides)
    pts = []
    for i in range(points * 2):
        ang = math.pi * i / points
        rad = r if i % 2 == 0 else r * 0.35
        pts.append((cx + rad * math.sin(ang), cy - rad * math.cos(ang)))
    draw.polygon(pts, fill=fill)

def add_sparkles(img, count, rmin, rmax, alpha=255):
    overlay = Image.new('RGBA', img.size, (0,0,0,0))
    d = ImageDraw.Draw(overlay)
    w, h = img.size
    for _ in range(count):
        x = random.uniform(0, w)
        y = random.uniform(0, h)
        r = random.uniform(rmin, rmax)
        a = random.randint(int(alpha*0.5), alpha)
        draw_star(d, x, y, r, (255, 255, 255, a), points=4)
    img.paste(Image.alpha_composite(img.convert('RGBA'), overlay).convert('RGB'), (0,0))
    return img

def crescent_moon(size, fill=(255,255,255,235)):
    m = Image.new('RGBA', (size, size), (0,0,0,0))
    d = ImageDraw.Draw(m)
    d.ellipse([0,0,size-1,size-1], fill=fill)
    cut = Image.new('RGBA', (size, size), (0,0,0,0))
    dc = ImageDraw.Draw(cut)
    off = int(size*0.32)
    dc.ellipse([off,-int(size*0.05),off+size-1,size-1-int(size*0.05)], fill=(0,0,0,255))
    r,g,b,a = m.split()
    _,_,_,ca = cut.split()
    # subtract cut alpha from moon alpha
    new_a = Image.eval(a, lambda v: v)
    from PIL import ImageChops
    new_a = ImageChops.subtract(a, ca)
    m = Image.merge('RGBA', (r,g,b,new_a))
    return m

def note_glyph(size, fill=(255,255,255,240)):
    # simple stylized eighth-note: circle notehead + stem + flag, tilted look via two notes (beamed) 
    img = Image.new('RGBA', (size, size), (0,0,0,0))
    d = ImageDraw.Draw(img)
    head_r = size*0.15
    stem_w = size*0.06
    stem_h = size*0.55
    # two notes beamed together
    for i, dx in enumerate([-size*0.22, size*0.12]):
        base_x = size*0.5 + dx
        base_y = size*0.78
        d.ellipse([base_x-head_r, base_y-head_r, base_x+head_r, base_y+head_r], fill=fill)
        stem_top = base_y - stem_h
        d.rectangle([base_x+head_r*0.55, stem_top, base_x+head_r*0.55+stem_w, base_y], fill=fill)
    # beam connecting the two stems
    x1 = size*0.5 - size*0.22 + head_r*0.55
    x2 = size*0.5 + size*0.12 + head_r*0.55 + stem_w
    y_top = size*0.78 - stem_h
    d.polygon([(x1, y_top), (x2, y_top-size*0.02), (x2, y_top+size*0.09), (x1, y_top+size*0.11)], fill=fill)
    return img

def rounded_mask(size, radius):
    mask = Image.new('L', size, 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0,0,size[0]-1,size[1]-1], radius=radius, fill=255)
    return mask

# ================= 1. App icon (1024x1024, rounded square, moon+note+sparkles) =================
S = 1024
icon = gradient(S, S)
icon = icon.filter(ImageFilter.GaussianBlur(0))
icon_rgba = icon.convert('RGBA')

# soft glow blob behind the moon
glow = Image.new('RGBA', (S, S), (0,0,0,0))
gd = ImageDraw.Draw(glow)
gd.ellipse([S*0.18,S*0.14,S*0.82,S*0.78], fill=(255,255,255,60))
glow = glow.filter(ImageFilter.GaussianBlur(60))
icon_rgba = Image.alpha_composite(icon_rgba, glow)

moon = crescent_moon(int(S*0.46))
icon_rgba.alpha_composite(moon, (int(S*0.27), int(S*0.16)))

note = note_glyph(int(S*0.42))
icon_rgba.alpha_composite(note, (int(S*0.32), int(S*0.42)))

icon_rgba = add_sparkles(icon_rgba.convert('RGB'), 14, S*0.012, S*0.028).convert('RGBA')

mask = rounded_mask((S,S), int(S*0.22))
final_icon = Image.new('RGBA', (S,S), (0,0,0,0))
final_icon.paste(icon_rgba, (0,0), mask)
final_icon.save('/home/claude/resonance/build/icon_1024.png')

# multi-size .ico
sizes = [(256,256),(128,128),(64,64),(48,48),(32,32),(16,16)]
final_icon.save('/home/claude/resonance/build/icon.ico', sizes=sizes)

# ================= 2. Installer sidebar (164x314, welcome/finish page) =================
SW, SH = 164, 314
side = Image.new('RGB', (SW, SH))
px = side.load()
for y in range(SH):
    for x in range(SW):
        t = y / SH
        if t < 0.5:
            c = lerp(STOP_A, STOP_B, t*2)
        else:
            c = lerp(STOP_B, STOP_C, (t-0.5)*2)
        px[x,y] = c
side_rgba = side.convert('RGBA')
side_rgba = add_sparkles(side, 10, 3, 7).convert('RGBA')

moon_s = crescent_moon(90)
side_rgba.alpha_composite(moon_s, (int(SW/2-45), 60))
note_s = note_glyph(80)
side_rgba.alpha_composite(note_s, (int(SW/2-40), 150))

try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
except Exception:
    font = ImageFont.load_default()
d = ImageDraw.Draw(side_rgba)
text = "Resonance"
bbox = d.textbbox((0,0), text, font=font)
tw = bbox[2]-bbox[0]
d.text(((SW-tw)/2, 250), text, font=font, fill=(255,255,255,255))

side_rgba.convert('RGB').save('/home/claude/resonance/build/installerSidebar.bmp', 'BMP')

# uninstaller sidebar: cooler-toned variant (blue -> lavender), same layout
side2 = Image.new('RGB', (SW, SH))
px2 = side2.load()
for y in range(SH):
    for x in range(SW):
        t = y / SH
        c = lerp(STOP_C, STOP_A, t)
        px2[x,y] = c
side2_rgba = add_sparkles(side2, 10, 3, 7).convert('RGBA')
side2_rgba.alpha_composite(moon_s, (int(SW/2-45), 60))
side2_rgba.alpha_composite(note_s, (int(SW/2-40), 150))
d2 = ImageDraw.Draw(side2_rgba)
d2.text(((SW-tw)/2, 250), text, font=font, fill=(255,255,255,255))
side2_rgba.convert('RGB').save('/home/claude/resonance/build/uninstallerSidebar.bmp', 'BMP')

# ================= 3. Installer header (150x57, top banner on inner pages) =================
HW, HH = 150, 57
head = Image.new('RGB', (HW, HH), (250, 248, 255))
hd = ImageDraw.Draw(head)
# small gradient chip + wordmark, kept mostly light bg since MUI header shows page titles in black text beside it
chip = gradient(40, 40)
chip_rgba = chip.convert('RGBA')
moon_h = crescent_moon(28)
chip_rgba.alpha_composite(moon_h, (6, 6))
mask40 = rounded_mask((40,40), 10)
head_rgba = head.convert('RGBA')
head_rgba.paste(chip_rgba, (8, 8), mask40)
head_rgba.convert('RGB').save('/home/claude/resonance/build/installerHeader.bmp', 'BMP')

print("done")
