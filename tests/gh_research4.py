"""最后一轮: Tabby 协议包依赖原文 + WindTerm wiki 功能"""
import json, subprocess

PX = ["curl", "-s", "-m", "30", "-x", "http://127.0.0.1:10812", "--ssl-no-revoke"]

def gh(url):
    r = subprocess.run(PX + [url], capture_output=True, text=True)
    return r.stdout

print("=== 1. tabby-ssh package.json (依赖原文) ===")
raw = gh("https://raw.githubusercontent.com/Eugeny/tabby/master/tabby-ssh/package.json")
try:
    d = json.loads(raw)
    print(json.dumps(d.get("dependencies", {}), indent=2))
except Exception:
    print("解析失败, 原文前 600 字符:")
    print(raw[:600])

print("\n=== 2. tabby-serial package.json (依赖原文) ===")
raw = gh("https://raw.githubusercontent.com/Eugeny/tabby/master/tabby-serial/package.json")
try:
    d = json.loads(raw)
    print(json.dumps(d.get("dependencies", {}), indent=2))
except Exception:
    print("解析失败, 原文前 600 字符:")
    print(raw[:600])

print("\n=== 3. tabby-telnet package.json (依赖原文) ===")
raw = gh("https://raw.githubusercontent.com/Eugeny/tabby/master/tabby-telnet/package.json")
try:
    d = json.loads(raw)
    print(json.dumps(d.get("dependencies", {}), indent=2))
except Exception:
    print("解析失败, 原文前 600 字符:")
    print(raw[:600])

print("\n=== 4. WindTerm 功能清单 (官方 wiki) ===")
raw = gh("https://raw.githubusercontent.com/wiki/kingToolbox/WindTerm/Home.md")
print(raw[:3500] if raw and "404" not in raw[:20] else "(wiki Home 不可达, 试官网)")
if not raw or "404" in raw[:20]:
    raw2 = gh("https://kingtoolbox.github.io/")
    print(raw2[:2500])
