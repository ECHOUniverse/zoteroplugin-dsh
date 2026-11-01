# DSH 双半插件：宿主半持 webServer 路由，客户端半占右侧单标签

## Status

accepted

## Considered Options

- 客户端半直连 Zotero Local API：被否决——写入 key 会出现在浏览器进程，且跨会话缓存与 Agent 工具无法共享连接状态。
- 通过 `ctx.remote` 暴露宿主逻辑：0.2.1-rc.2 的 Remote 面由官方 `dsh-api-*-controller`（typert 协议）声明，第三方插件可扩展性未经文档化，弃用。
- 右栏开多个 tab（文库、阅读器、设置各一个）：被否决——dockkit 多 tab 会碎片化导航状态，也挤占其他插件的右栏空间。

## Decision

按 DSH 插件惯例做成双半（two-half）包：**宿主半**（`src/index.ts`，tsc 编译为 `lib/index.js`）持有配置 schema，并在 profile 提供 `webServer` 服务（`@deepseek-ai/dsh-host-webserver`，桌面 profile 经 `@deepseek-ai/dsh-web-app` 组合该依赖，已在本机 0.2.1-rc.2 的 desktop profile 依赖清单确认）时以 `prefix` 路由注册 `/dsh-zotero/*`，作为 Zotero Local API 的唯一出口与 Agent 工具的执行位置；**客户端半**（`src/client.tsx`，esbuild 打包为 `__ModuleLoader__` 工厂格式 `lib/client.js`）注册右栏的一个 page 型 tab（`sidebarRightTabs` + keyed 槽 `sidebar.right.pane.tab`，kind `zotero`），标签内用自建 store 做内部导航。客户端半经相对路径 fetch 调宿主路由（同源）；page 型 tab 每个 pane 自动去重，天然满足“单标签”。

## Consequences

- 客户端半的宿主可达性依赖 webServer 存在：无 web 组合的 profile 里插件仍可激活（防御式查找），但功能面显示不可用。
- 客户端半不得持有 Zotero key、不得直接 fetch `127.0.0.1:23119`；违反此线的 PR 一律拒绝。
- 单标签内的导航状态（当前库/集合/条目/页）由客户端 store 持有，宿主不保存 UI 状态。
- `sidebar.right.pane.tab` 槽组件的注入 props 形状（`hooks.tabInfo`）需真机确认（见 implementation-spec 验证点 V-1）。
