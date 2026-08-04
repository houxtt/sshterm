"""调研 GitHub 主流多协议终端工具: stars/语言/活跃度/技术栈"""
import json, subprocess, sys

REPOS = [
    "Eugeny/tabby",              # 现代多功能终端 (SSH/串口/本地), Electron
    "xtermjs/xterm.js",          # 终端仿真事实标准 (VSCode 在用)
    "microsoft/node-pty",        # Windows 伪终端层 (ConPTY)
    "wez/wezterm",               # Rust GPU 终端
    "Serial-Studio/Serial-Studio",   # 开源串口可视化工具
    "TeraTermProject/teraterm",  # 老牌 C++ 终端, 支持串口+SSH
    "sedwards2009/extraterm",    # 功能型终端
    "vercel/hyper",              # Electron 终端
    "mscdex/ssh2",               # Node SSH 库
    "serialport/node-serialport",# Node 串口库
]

def gh(url):
    r = subprocess.run(["curl", "-s", "-m", "25", "-x", "http://127.0.0.1:10812",
                        "--ssl-no-revoke", url],
                       capture_output=True, text=True)
    return r.stdout

print("=== GitHub 主流多协议终端工具调研 ===\n")
for repo in REPOS:
    out = gh(f"https://api.github.com/repos/{repo}")
    try:
        d = json.loads(out)
        if "full_name" not in d:
            print(f"{repo}: API 返回异常: {out[:120]}")
            continue
        print(f"★ {d['stargazers_count']:>7,} | {d['language'] or '?':<10} | "
              f"更新 {d['pushed_at'][:10]} | forks {d['forks_count']:>6,} | {repo}")
        print(f"    {d['description'] or ''}")
    except Exception as e:
        print(f"{repo}: 解析失败 {e} | {out[:120]}")
