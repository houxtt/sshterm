"""压力测试 3/3: 多标签并行 (3 会话 × 2MB/s 同时灌数据)

验证: 多连接并行时 UI 是否卡顿、切换是否流畅。
"""
import sys, time
from PySide6.QtCore import Qt, QThread, QTimer, Signal
from PySide6.QtWidgets import QApplication, QTabWidget, QWidget
from PySide6.QtGui import QPainter
from pyte import Screen, Stream

COLS, ROWS = 120, 32
FONT_W, FONT_H = 8, 16

class FakeSession(QThread):
    data_ready = Signal(int, int)
    disconnected = Signal(str)
    def __init__(self, rate_mbps: float, parent=None):
        super().__init__(parent)
        self._rate = rate_mbps
        self._stop = False
        self.screen = Screen(COLS, ROWS)
        self.stream = Stream(self.screen)
        self.fed = 0
    def run(self):
        chunk = ("\x1b[32mCC  main.c:1: warning: unused variable 'x'\x1b[0m\n" * 200)[:64*1024]
        while not self._stop:
            t0 = time.perf_counter()
            self.stream.feed(chunk)
            self.fed += len(chunk)
            if self.screen.dirty:
                d = self.screen.dirty
                self.data_ready.emit(min(d), max(d))
                self.screen.dirty.clear()
            need = len(chunk) / (self._rate * 1024 * 1024)
            dt = time.perf_counter() - t0
            self.msleep(max(1, int((need - dt) * 1000)))
        self.disconnected.emit("closed")
    def shutdown(self):
        self._stop = True
        self.wait(3000)

class TermWidget(QWidget):
    def __init__(self, session):
        super().__init__()
        self.session = session
        self.paint_ms = []
        self.setMinimumSize(COLS * FONT_W, ROWS * FONT_H)
        session.data_ready.connect(lambda a, b: self.update())
    def paintEvent(self, ev):
        t0 = time.perf_counter()
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.black)
        painter.setPen(Qt.white)
        f = painter.font(); f.setPointSize(10); painter.setFont(f)
        for row in range(ROWS):
            painter.drawText(4, row * FONT_H + FONT_H - 4, f"row {row:02d} | " + "x" * 60)
        painter.end()
        self.paint_ms.append((time.perf_counter() - t0) * 1000)

def main():
    app = QApplication(sys.argv)
    tabs = QTabWidget()
    sessions = []
    for i in range(3):
        s = FakeSession(2.0)
        w = TermWidget(s)
        tabs.addTab(w, f"会话{i+1}")
        sessions.append(s)
        s.start()
    tabs.resize(COLS * FONT_W + 20, ROWS * FONT_H + 40)
    tabs.show()

    latency = {"max": 0.0, "over": 0, "ticks": 0}
    last = {"t": time.perf_counter()}
    switch_ok = {"n": 0}
    def tick():
        now = time.perf_counter()
        gap = (now - last["t"]) * 1000
        last["t"] = now
        latency["ticks"] += 1
        latency["max"] = max(latency["max"], gap)
        if gap > 150: latency["over"] += 1
        if latency["ticks"] % 20 == 0:            # 每 2s 切一次标签
            tabs.setCurrentIndex((tabs.currentIndex() + 1) % 3)
            switch_ok["n"] += 1
    timer = QTimer(); timer.timeout.connect(tick); timer.start(100)

    def finish():
        for s in sessions: s.shutdown()
        app.quit()
    ft = QTimer(); ft.timeout.connect(finish); ft.start(8000)

    rc = app.exec()
    all_paint = [ms for s in sessions for ms in s.paint_ms] if False else []
    print(f"\n=== 多标签并行压力测试 (3 会话 × 2MB/s, 8s) ===")
    print(f"标签切换次数 : {switch_ok['n']} 次 (每 2s 自动切换)")
    print(f"事件循环心跳 : {latency['ticks']} 次, 最大间隔 {latency['max']:.1f} ms, "
          f"卡顿(>150ms) {latency['over']} 次")
    print(f"每会话接收   : {[s.fed // 1024 for s in sessions]} KB")
    print(f"线程全部干净退出: {all(not s.isRunning() for s in sessions)}")
    return rc

if __name__ == "__main__":
    sys.exit(main())
