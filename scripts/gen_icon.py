#!/usr/bin/env python3
# 生成 sshterm 终端风格图标 (纯标准库, 无第三方依赖)
# 输出: assets/icon.png (原始大图, 供转 ico)
import zlib, struct, math, os

W = H = 512
px = [[(0,0,0,0) for _ in range(W)] for _ in range(H)]  # RGBA

def setp(x, y, r, g, b, a=255):
    if 0 <= x < W and 0 <= y < H:
        px[y][x] = (r, g, b, a)

def fill_round_rect(x0, y0, x1, y1, rad, color):
    for y in range(y0, y1):
        for x in range(x0, x1):
            # 圆角裁剪
            cx = min(max(x, x0+rad), x1-rad)
            cy = min(max(y, y0+rad), y1-rad)
            if (x-cx)**2 + (y-cy)**2 > rad*rad:
                continue
            setp(x, y, *color)

# 背景: 圆角深蓝灰 (#1e2430)
fill_round_rect(16, 16, W-16, H-16, 88, (30, 36, 48, 255))

# 顶部栏浅色条 (#2b3340)
for y in range(16, 16+64):
    for x in range(32, W-32):
        cx = min(max(x, 32+16), W-32-16)
        cy = 16+16
        if (x-cx)**2 + (y-cy)**2 <= 16*16:
            continue
        setp(x, y, 43, 51, 64, 255)

# 三个红黄绿圆点 (mac 风)
dots = [(255,95,86), (255,189,46), (39,201,63)]
dx = 70
for i, c in enumerate(dots):
    cx, cy, r = dx + i*52, 48, 16
    for y in range(cy-r, cy+r):
        for x in range(cx-r, cx+r):
            if (x-cx)**2 + (y-cy)**2 <= r*r:
                setp(x, y, *c)

# 提示符 >_  (亮青色 #36d6c3)
def draw_glyph_prompt():
    # ">" 用折线, "_" 用横条
    col = (54, 214, 195, 255)
    # ">": 两笔
    # 上斜
    for t in range(0, 120):
        x = 150 + t*0.45
        y = 250 - t*0.55
        for d in range(-10, 10):
            setp(int(round(x)), int(round(y))+d, *col)
    # 下斜
    for t in range(0, 120):
        x = 150 + t*0.45
        y = 250 + t*0.55
        for d in range(-10, 10):
            setp(int(round(x)), int(round(y))+d, *col)
    # "_"
    for x in range(240, 330):
        for d in range(-6, 6):
            setp(x, 360+d, *col)

draw_glyph_prompt()

# 写 PNG
def write_png(path, width, height, rows):
    def chunk(typ, data):
        c = typ + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for row in rows:
        raw += b'\x00' + bytes(row)
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw, 9)
    with open(path, 'wb') as f:
        f.write(sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))

flat = []
for y in range(H):
    for x in range(W):
        r, g, b, a = px[y][x]
        flat.append((r, g, b, a))
write_png('assets/icon.png', W, H, flat)
print('wrote assets/icon.png', W, 'x', H)
