"""深挖: Tabby monorepo 结构 + WindTerm 功能清单 + xterm.js 能力"""
import json, subprocess, re

PX = ["curl", "-s", "-m", "30", "-x", "http://127.0.0.1:10812", "--ssl-no-revoke"]

def gh(url):
    r = subprocess.run(PX + [url], capture_output=True, text=True)
    return r.stdout

print("=== 1. Tabby monorepo 顶层结构 ===")
try:
    d = json.loads(gh("https://api.github.com/repos/Eugeny/tabby/contents/"))
    for it in d:
        t = it["type"]
        print(f"  [{t:5s}] {it['name']}")
except Exception as e:
    print(f"  失败: {e}")

print("\n=== 2. Tabby 协议插件包 (tabby-* 依赖分析) ===")
for pkg in ["tabby-core", "tabby-terminal", "tabby-ssh", "tabby-serial", "tabby-telnet"]:
    d = json.loads(gh(f"https://raw.githubusercontent.com/Eugeny/tabby/master/{pkg}/package.json"))
    deps = d.get("dependencies", {})
    print(f"  {pkg}: " + ", ".join(f"{k}@{v}" for k, v in deps.items() if k.startswith(("ssh2", "node-pty", "xterm", "serialport", "tabby"))))

print("\n=== 3. WindTerm 功能清单 (README 要点) ===")
try:
    md = gh("https://raw.githubusercontent.com/kingToolbox/WindTerm/master/README.md")
    # 提取 Features 部分
    for m in re.finditer(r"^#{1,3} .*", md, re.M):
        pass
    lines = md.splitlines()
    started = False
    out = []
    for ln in lines:
        if re.match(r"^#+\s*(Features|特性|Overview|Introduction)", ln, re.I):
            started = True
        elif started and re.match(r"^#+\s", ln) and "Feature" not in ln:
            break
        if started:
            out.append(ln)
    print("\n".join(out[:60]) if out else "(README 结构异常, 取前 40 行)")
    if not out:
        print("\n".join(lines[:40]))
except Exception as e:
    print(f"  失败: {e}")

print("\n=== 4. xterm.js 能力清单 (README 特性) ===")
try:
    md = gh("https://raw.githubusercontent.com/xtermjs/xterm.js/master/README.md")
    idx = md.lower().find("features")
    print(md[idx:idx + 1200] if idx >= 0 else md[:1200])
except Exception as e:
    print(f"  失败: {e}")
