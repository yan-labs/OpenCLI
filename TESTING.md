# Testing Guide

统一的测试职责、运行命令与 CI 策略见 [开发者测试指南](docs/developer/testing.md)。

```bash
npm ci
npm run build
npm test
```

`npm test` 运行 unit、extension 和 adapter tests。
真实 CLI contract 与站点 E2E 的运行方式见指南；它们不包含在默认测试命令中。
