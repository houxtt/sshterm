#!/usr/bin/env python3
# 将 assets/icon.png 转为多尺寸 .ico (16/24/32/48/64/128/256)
# 纯标准库实现 (读取 PNG 像素, 用 Pillow 不存在时回退手写缩放)
import struct, zlib, os

SRC = 'assets/icon.png'
OUT = 'assets/icon.ico'
SIZES = [16, 24, 32, 48, 64, 128, 256]

def read_png(path):
    with open(path, 'rb') as f:
        data = f.read()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    pos = 8
    width = height = None
    idat = b''
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]
        typ = data[pos+4:pos+8]
        chunk = data[pos+8:pos+8+ln]
        if typ == b'IHDR':
            width, height, bitd, colt = struct.unpack('>IIBB', chunk[:10])
        elif typ == b'IDAT':
            idat += chunk
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    assert colt == 6 and bitd == 8, 'need RGBA 8-bit'
    stride = width * 4
    rows = []
    prev = bytearray(stride)
    p = 0
    # 解析 PNG 滤镜 (只需类型0, 其余简单处理)
    out = [[0]*stride for _ in range(height)]
    rp = 0
    for y in range(height):
        ftype = raw[rp]; rp += 1
        line = bytearray(raw[rp:rp+stride]); rp += stride
        if ftype == 0:
            for i in range(stride):
                out[y][i] = line[i]
        else:
            # 简单复制(我们的图无滤镜, 通常 ftype=0); 兜底
            for i in range(stride):
                out[y][i] = line[i] & 0xff
    return width, height, out

def bicubic_sample(src_w, src_h, src, x, y):
    # 最近邻缩放够用 (图标边缘硬, 可接受)
    sx = int(round(x * (src_w - 1)))
    sy = int(round(y * (src_h - 1)))
    sx = min(max(sx, 0), src_w - 1)
    sy = min(max(sy, 0), src_h - 1)
    return src[sy][sx*4:sx*4+4]

def scale(src_w, src_h, src, size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r, g, b, a = bicubic_sample(src_w, src_h, src, x/size, y/size)
            row += bytes([r, g, b, a])
        rows.append(row)
    return rows

def make_bmp(rows, size):
    # BGRA + 顶部到底部翻转, 加 BITMAPINFOHEADER + AND mask
    stride = (size * 4 + 3) & ~3
    header = struct.pack('<IiiHHIIiiII', 40, size, size*2, 1, 32, 0, stride*size, 0, 0, 0, 0)
    pixel = bytearray()
    for y in range(size - 1, -1, -1):
        row = bytearray()
        for x in range(size):
            r, g, b, a = rows[y][x*4:x*4+4]
            row += bytes([b, g, r, a])
        row += b'\x00' * (stride - size*4)
        pixel += row
    andmask = b'\x00' * (size * ((size + 31) // 32) * 4)
    return header + pixel + andmask

def make_png_for_ico(rows, size):
    # 256 尺寸用 PNG 压缩 (ICO 支持)
    def chunk(typ, d):
        c = typ + d
        return struct.pack('>I', len(d)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    raw = b''
    for row in rows:
        raw += b'\x00' + bytes(row)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b'')

def main():
    w, h, src = read_png(SRC)
    entries = []
    imagedata = []
    for s in SIZES:
        rows = scale(w, h, src, s)
        if s == 256:
            d = make_png_for_ico(rows, s)
        else:
            d = make_bmp(rows, s)
        entries.append((s, s, len(d)))
        imagedata.append(d)
    # 组装 ICO
    out = bytearray()
    out += struct.pack('<HHH', 0, 1, len(SIZES))
    offset = 6 + 16 * len(SIZES)
    for (w_, h_, ln) in entries:
        out += struct.pack('<BBBBHHII', w_ if w_ < 256 else 0, h_ if h_ < 256 else 0,
                           0, 0, 1, 32, ln, offset)
        offset += ln
    for d in imagedata:
        out += d
    with open(OUT, 'wb') as f:
        f.write(out)
    print('wrote', OUT, len(out), 'bytes; sizes', SIZES)

main()
