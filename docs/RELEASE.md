# 发布流程

外部分发由 GitHub Actions 的 `Release build` 工作流生成。仓库未配置签名证书时，工作流会发布明确标注为未签名的 EXE。

## 一次性配置

如需代码签名，在仓库 Actions secrets 中同时设置：

- `SIGNING_CERT_BASE64`：PFX 文件的 Base64 内容；
- `SIGNING_CERT_PASSWORD`：PFX 密码。

建议使用长期一致的组织签名身份或 Microsoft Artifact Signing。不要提交 PFX、密码或自签名证书到仓库。

## 每次发布

1. 更新 `package.json` 的版本和变更日志。
2. 本地运行 `npm run check`、`node tests/desktop_contract.js`，并构建、试运行桌面 EXE。
3. 在 Actions 手动运行 `Release build`，输入相同版本号。
4. 工作流构建并测试桌面 EXE；若配置了签名证书，还会签名并执行 `signtool verify /pa /all`。成功后创建 `vX.Y.Z` GitHub Release 并上传 `sshterm.exe`，未签名时在发行说明中标明。

发布前还应检查依赖审计结果。未签名 EXE 在 Windows 首次运行时可能显示安全提示。
