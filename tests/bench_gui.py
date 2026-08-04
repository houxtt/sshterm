"""压力测试 2/3: GUI 原型实测 (PySide6)

最小验证 = 架构的正确性证据:
  - 工作线程: 高速数据流 → pyte.feed → 发 dirty 信号
  - UI 线程:   收信号 → update() → paintEvent 渲染
测量:
  - paintEvent 平均耗时 (重绘开销)
  - 事件循环延迟 (QTimer 实际间隔 vs 设定间隔, >150ms 记为卡顿)
  - 断连/重连模拟: 线程被 shutdown 后是否干净退出

用法: python tests/bench_gui.py [--rate 3.0] [--seconds 8]
"""
import sys, time, argparse
from PySide6.QtCore import (Qt, QThread, QTimer, Signal, QObject)
from PySide6.QtWidgets import QApplication, QWidget
from pyte import Screen, Stream

COLS, ROWS = 120, 32
FONT_W, FONT_H = 8, 16

# ---------- 模拟工作线程 (与正式架构同构) ----------
class FakeSession(QThread):
    data_ready = Signal(int, int)        # dirty 行范围 (无需传内容, 测试渲染)
    disconnected = Signal(str)
    def __init__(self, rate_mbps: float, parent=None):
        super().__init__(parent)
        self._rate = rate_mbps
        self._stop = False
        self.screen = Screen(COLS, ROWS)
        self.stream = Stream(self.screen)
    def run(self):
        chunk = ("\x1b[32mCC  main.c:1: warning: unused variable 'x'\x1b[0m\n" * 200)  # 100 行/块
        chunk = chunk[:64 * 1024]
        while not self._stop:
            t0 = time.perf_counter()
            self.stream.feed(chunk)
            if self.screen.dirty:
                d = self.screen.dirty
                self.data_ready.emit(min(d), max(d))
                self.screen.dirty.clear()
            # 按目标速率节流 (每块 ~64KB)
            need = len(chunk) / (self._rate * 1024 * 1024)
            dt = time.perf_counter() - t0
            if need > dt:
                self.msleep(int((need - dt) * 1000))
            else:
                self.msleep(1)   # 全速时也留调度缝隙
        self.disconnected.emit("closed")
    def shutdown(self):
        self._stop = True
        self.wait(3000)

# ---------- 最小终端控件 (与正式架构同构) ----------
class TermWidget(QWidget):
    def __init__(self, session):
        super().__init__()
        self.session = session
        self.paint_ms = []              # 每次 paintEvent 耗时
        self.setMinimumSize(COLS * FONT_W, ROWS * FONT_H)
        session.data_ready.connect(lambda a, b: self.update())   # update() 合并重绘
        session.disconnected.connect(lambda s: self.setWindowTitle(f"已断开: {s}"))
    def paintEvent(self, ev):
        t0 = time.perf_counter()
        from PySide6.QtGui import QPainter
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.black)
        painter.setPen(Qt.white)
        f = painter.font(); f.setPointSize(10); painter.setFont(f)
        # 只重绘 dirty 行 (正式版按 dirty 渲染, 这里全画 = 最坏情况)
        for row in range(ROWS):
            y = row * FONT_H
            painter.drawText(4, y + FONT_H - 4, f"row {row:02d} | " + "x" * 60)
        painter.end()
        self.paint_ms.append((time.perf_counter() - t0) * 1000)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=float, default=3.0, help="数据速率 MB/s (pyte上限约1.7-3.4)")
    ap.add_argument("--seconds", type=float, default=8.0)
    ap.add_argument("--offscreen", action="store_true")
    args = ap.parse_args()

    if args.offscreen:
        from PySide6.QtCore import QCoreApplication
        import os; os.environ["QT_QPA_PLATFORM"] = "offscreen"
    app = QApplication(sys.argv)

    session = FakeSession(args.rate)
    term = TermWidget(session)
    term.resize(COLS * FONT_W, ROWS * FONT_H)
    term.show()

    # 事件循环延迟监视器: 100ms 心跳, 实际间隔 > 150ms = 卡顿
    latency = {"max": 0.0, "over": 0, "ticks": 0}
    last = {"t": time.perf_counter()}
    def tick():
        now = time.perf_counter()
        gap = (now - last["t"]) * 1000
        last["t"] = now
        latency["ticks"] += 1
        latency["max"] = max(latency["max"], gap)
        if gap > 150:
            latency["over"] += 1
    timer = QTimer(); timer.timeout.connect(tick); timer.start(100)

    t_end = time.perf_counter() + args.seconds
    def finish():
        session.shutdown()
        app.quit()
    ft = QTimer(); ft.timeout.connect(finish); ft.start(int(args.seconds * 1000))

    session.start()
    rc = app.exec()

    n = len(term.paint_ms)
    avg = sum(term.paint_ms) / max(n, 1)
    worst = max(term.paint_ms) if term.paint_ms else 0
    print(f"\n=== GUI 压力测试结果 (数据速率 {args.rate} MB/s, {args.seconds}s) ===")
    print(f"重绘次数       : {n} 次 ({n / args.seconds:.0f} fps)")
    print(f"paintEvent 平均: {avg:.3f} ms  最坏: {worst:.3f} ms")
    print(f"事件循环心跳   : {latency['ticks']} 次, 最大间隔 {latency['max']:.1f} ms, "
          f"卡顿(>150ms) {latency['over']} 次")
    print(f"线程干净退出   : {not session.isRunning()}")
    return rc

if __name__ == "__main__":
    sys.exit(main())
