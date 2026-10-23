# 安全

## 报告漏洞

请不要开公开 Issue 报告安全问题。

发邮件到仓库维护者账号关联邮箱，或通过 GitHub Security Advisories 私下报告：

https://github.com/CCharlie-xiu/wuch-ai/security/advisories/new

请尽量包含：影响范围、复现步骤、是否已有公开利用。我们会尽快确认并回复处理计划。

## 范围说明

- 线上试用版（wuch-ai.net）按账号隔离；请勿尝试越权访问他人会话或数据。
- 本地 `bun run dev` 面向本机开发，默认会回传本机保存的模型 Key 给页面，不要把开发端口暴露到公网。
