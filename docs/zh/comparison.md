---
title: OpenCLI browser automation 对比
description: OpenCLI 支持 general-purpose browser automation，可作为 agent-browser 的替代工具。了解 browser primitives 与可复用 adapters 的区别。
---

# OpenCLI browser automation 对比

**OpenCLI 支持 general-purpose browser automation，可以作为 agent-browser 的替代工具。** 没有预置 adapter 的网站，也能通过 `opencli browser` 直接导航、检查页面、点击、填表、提取和截图。

如果你正在迁移现有 workflow，请先看 [OpenCLI vs agent-browser 与命令迁移](./guide/agent-browser-alternative)。更多工具的对比见 [English comparison](../comparison)。

## 按任务选择使用方式

| 任务 | OpenCLI 的使用方式 |
|------|-------------------|
| 探索陌生网站、完成多步 browser workflow | 使用 `opencli browser <session> <command>`，无需 adapter |
| 让 AI Agent 操作已登录网页 | 安装 `opencli-browser` skill，通过 Browser Bridge 复用 Chrome 登录态 |
| 定时获取站点内容、重复运行固定流程 | 调用现成 adapter commands，获取结构化输出 |
| 把探索过的流程变成可复用命令 | 编写 site adapter |

OpenCLI 和 agent-browser 都能提供 Agent 使用的 browser primitives。OpenCLI 还提供现成站点命令，将重复任务封装为一次结构化调用。两者的命令语法、element references、session lifecycle 和输出格式不同，迁移时需要逐项验证。

## 实际限制

- 现成站点命令的覆盖范围取决于 adapters，但 browser automation 不受 adapter 列表限制。
- 网站 DOM 或 API 变化时，adapter 可能需要维护。
- 通用 browser workflow 仍需要 script 或 AI Agent 决定操作步骤、观察页面状态并处理错误。
- OpenCLI 命令本身不依赖 LLM inference；负责规划操作的 AI Agent 仍有自身的 model costs。

## 开始使用

- [快速开始](./guide/getting-started)
- [Browser Bridge 设置](./guide/browser-bridge)
- [扩展 OpenCLI](./guide/extending-opencli)
