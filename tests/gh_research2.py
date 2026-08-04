"""补充调研: WezTerm 星数 + Tabby 依赖清单 + 关键词搜索排行"""
import json, subprocess

PX = ["curl", "-s", "-m", "25", "-x", "http://127.0.0.1:10812", "--ssl-no-revoke"]

def gh(url):
    r = subprocess.run(PX + [url], capture_output=True, text=True)
    return r.stdout

print("=== 补充 1: WezTerm (302 重定向修正) ===")
d = json.loads(gh("https://api.github.com/repositories/120568143"))
print(f"★ {d['stargazers_count']:>7,} | {d['language']} | 更新 {d['pushed_at'][:10]} | {d['full_name']}")
print(f"    {d['description']}")

print("\n=== 补充 2: Tabby 技术栈 (package.json 依赖) ===")
d = json.loads(gh("https://raw.githubusercontent.com/Eugeny/tabby/master/package.json"))
for k in ("dependencies", "devDependencies"):
    print(f"--- {k} (前 25 项) ---")
    items = sorted(d.get(k, {}).items(), key=lambda x: -len(x[0]))[:25] if k == "dependencies" else list(d.get(k, {}).items())[:25]
    for name, ver in items:
        print(f"  {name}: {ver}")

print("\n=== 补充 3: GitHub 搜索排行 (q=ssh serial terminal, 按 stars) ===")
d = json.loads(gh("https://api.github.com/search/repositories?q=ssh+serial+terminal&sort=stars&order=desc&per_page=8"))
for it in d.get("items", []):
    print(f"★ {it['stargazers_count']:>7,} | {it['language'] or '?':<10} | {it['full_name']:<32} | {it.get('description') or ''}")

print("\n=== 补充 4: GitHub 搜索 (q=serial terminal, 按 stars) ===")
d = json.loads(gh("https://api.github.com/search/repositories?q=serial+terminal&sort=stars&order=desc&per_page=8"))
for it in d.get("items", []):
    print(f"★ {it['stargazers_count']:>7,} | {it['language'] or '?':<10} | {it['full_name']:<32} | {it.get('description') or ''}")
