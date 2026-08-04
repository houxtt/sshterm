"""压力测试 1/3: pyte 解析吞吐基准 (纯 CPU, 无 GUI)

模拟三类真实高负载场景, 量化 pyte.feed() 每秒能消化多少数据。
依据: 若解析在工作线程, 只要 UI 线程只承担"脏行重绘", 
吞吐上限 = 解析吞吐 ≈ 系统不卡顿的理论上界。
"""
import time, random, io
from pyte import Screen, Stream

COLS, ROWS = 120, 32          # 典型终端尺寸

def make_payload(kind: str, size_mb: float) -> str:
    """构造 size_mb MB 的模拟终端数据流"""
    n_lines = int(size_mb * 1024 * 1024 / 120)
    out = io.StringIO()
    rng = random.Random(42)
    if kind == "build":        # make -j 编译输出: 普通行 + 少量颜色
        colors = ["\x1b[32m", "\x1b[31m", "\x1b[33m", "\x1b[0m", "\x1b[1m"]
        for _ in range(n_lines):
            c = rng.choice(colors)
            out.write(f"{c}CC  main.c:123: warning: unused variable 'x'\x1b[0m\n")
    elif kind == "xxd":        # cat /dev/urandom | xxd: 纯文本行, 无转义
        for _ in range(n_lines):
            out.write(f"0000ab30  de ad be ef 01 02 03 04  55 66 77 88 99 aa bb cc\n")
    elif kind == "progress":   # 进度条: 同一行疯狂 \r 重写
        for _ in range(n_lines):
            out.write(f"\r[{rng.randrange(100):3d}%] ==== downloading 123.4 MB")
    return out.getvalue()

def bench(kind: str, size_mb: float = 30.0):
    data = make_payload(kind, size_mb)
    screen = Screen(COLS, ROWS)
    stream = Stream(screen)
    t0 = time.perf_counter()
    stream.feed(data)
    dt = time.perf_counter() - t0
    mbps = size_mb / dt
    dirty = len(screen.dirty)
    print(f"[{kind:9s}] {size_mb:5.1f}MB in {dt*1000:8.1f} ms  =>  {mbps:7.1f} MB/s   "
          f"dirty行={dirty}")

if __name__ == "__main__":
    print(f"pyte 解析吞吐基准 (终端 {COLS}x{ROWS})")
    print("-" * 78)
    for kind in ("build", "xxd", "progress"):
        bench(kind, 30.0)
    # 参照: 真实场景的量级
    print("-" * 78)
    print("参照: 串口 921600 波特 ≈ 0.09 MB/s; SSH 高速输出通常 < 2 MB/s")
