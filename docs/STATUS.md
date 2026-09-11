# sshterm 当前状态（文档索引）

> 最后更新：**2026-09-11**  
> 工作区：`D:\\sshterm`（Gitee `wei-peng-yi-yu/sshterm`）

本文是**现行事实**入口。历史调研 / 审计正文可能仍保留旧措辞；以本节与下列「已对齐」文档为准。

## 产品能力（现行）

| 能力 | 状态 |
|---|---|
| SSH 密码 / 密钥 / 代理 / 跳板 / 隧道 / 自动重连 / MFA 对话框 | ✅ |
| SFTP 浏览、上传下载、断点续传、目录拖放、目录 ZIP | ✅（非完整远端文件管理：无重命名/删除/chmod UI） |
| Telnet / 串口 / VNC | ✅ |
| 多标签、工作区、主题、快捷键、会话分组/过滤、DPAPI 记住密码 | ✅ |
| 分屏 | ✅ 逐次加到最多 4 格（2×2）；双格可拖分隔条 |
| Zmodem | ❌ **明确未支持**（已去掉浏览器半成品探测） |
| 独立 EXE | ✅ 脚本 `npm run build:exe`（caxa）；外发须走签名 Release 流程（见 RELEASE.md） |

## 2026-09-11 已落地修复

1. **操作级 error**：`ws-handlers` 带 `action`；前端仅连接级（无 action）才 `closed`。
2. **主机磁盘总量**：`df -Pk` 总量用 `$2`（可用 `$4`）；契约 `tests/df_host_stats_contract.js`。
3. **Zmodem**：移除 Sentry/`consume`；README / FEATURE-PLAN 标明未支持。
4. **分屏**：按钮加到 2×2；达上限提示用 ✕ 关闭。
5. **文档**：FEATURE-PLAN、审计叠加层、本 STATUS，以及 DESIGN / ARCHITECTURE / 补全计划 / README 对齐。

验证：`npm run test:static`（含上述新契约）应全绿。

## 文档地图

| 文档 | 角色 | 对齐到现行？ |
|---|---|---|
| [STATUS.md](STATUS.md) | **现行事实索引** | ✅ 本文 |
| [../README.md](../README.md) | 用户手册 | ✅ |
| [FEATURE-PLAN.md](FEATURE-PLAN.md) | 对标与优先级 | ✅（2026-09-11 状态条） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 模块结构 | ✅ |
| [RELEASE.md](RELEASE.md) | 签名发布流程 | ✅（流程本身） |
| [DESIGN.md](DESIGN.md) | 早期设计归档 | ✅ 顶部标明归档 + 指向 STATUS |
| [补全计划与工具链替换评估.md](补全计划与工具链替换评估.md) | 2026-08 评估归档 | ✅ 顶部叠加现行结论 |
| [audit-2026-09-07/REPORT.md](audit-2026-09-07/REPORT.md) | 缺陷审计（历史正文保留） | ✅ 顶部「修复状态更新」 |

## 仍开放（勿当已修）

- SFTP 远端重命名 / 删除 / 权限等完整文件管理
- 跳板机复杂 MFA（主连接 MFA UI 已有；跳板仍偏自动填密码）
- 会话日志明文落盘的隐私策略
- 多于双格时的分隔条拖拽
- 真机长稳 / EXE 全功能 smoke（见审计第 8 节风险）

更细条目以审计报告叠加层 + 历史正文为准。
