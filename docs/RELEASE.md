# 发布流程

外部分发必须由 GitHub Actions 的 `Release build` 工作流生成；该工作流拒绝上传未签名的 EXE。

## 一次性配置

在仓库 Actions secrets 中设置：

- `SIGNING_CERT_BASE64`：PFX 文件的 Base64 内容；
- `SIGNING_CERT_PASSWORD`：PFX 密码。

建议使用长期一致的组织签名身份或 Microsoft Artifact Signing。不要提交 PFX、密码或自签名证书到仓库。

## 每次发布

1. 更新 `package.json` 的版本和变更日志。
2. 本地运行 `npm run check` 与 `npm run test:workspace-security`。
3. 在 Actions 手动运行 `Release build`，输入相同版本号。
4. 工作流会构建、签名并执行 `signtool verify /pa /all`；只上传通过验证的产物。

发布前还应检查依赖审计结果，并将最终签名文件交由安装器/MSI 阶段使用。
