---
layout: home
description: 面向 AI Agent 的 general-purpose browser automation CLI。无需 site adapter 即可操作网页，也可作为 agent-browser 的替代工具。

hero:
  name: OpenCLI
  text: 让任何网站成为你的 CLI
  tagline: General-purpose browser automation · 复用 Chrome 登录态 · 可复用站点命令
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/getting-started
    - theme: alt
      text: 替代 agent-browser
      link: /zh/guide/agent-browser-alternative
    - theme: alt
      text: 在 GitHub 查看
      link: https://github.com/jackwener/opencli

features:
  - icon: 🌐
    title: 浏览器自动化
    details: AI Agent 直接导航、点击、填表、提取和截图。操作网页无需 site adapter。
  - icon: 🔐
    title: 账号安全
    details: 复用 Chrome 登录态，凭证永远不会离开浏览器 — 无 token，无密码泄露。
  - icon: 🤖
    title: AI Agent 就绪
    details: Browser 原语加上适配器编写 skill，让 AI Agent 可以稳定完成侦察、提取、验证和适配器落地。
  - icon: 💰
    title: 无内置 LLM 依赖
    details: 命令本身不调用 LLM。由 AI Agent 决定操作步骤时，仍有 Agent 自身的 model costs。
  - icon: 🔁
    title: Adapter 确定性输出
    details: 相同命令，相同输出结构，每次一致。可管道、可脚本、CI 友好。
---
