# 只经 Zotero Local API 访问，支持下限为 Zotero 10

## Status

accepted

## Context

插件需要一个数据来源访问用户的文库。候选有三条：直连 `zotero.sqlite`、Zotero Web API（api.zotero.org）、Zotero 桌面程序的 Local API（`http://127.0.0.1:23119/api/`）。Local API 在 Zotero 7 起随桌面程序提供（需在设置里开启），8 起支持经用户授权对话框的写入（`POST /api/local/authorize` 发放 key），10 是当前稳定线且具备完整的元数据检索（titleCreatorYear）、全文检索（everything 模式）、注释与群组访问能力。

## Decision

Local API 是本插件唯一的数据通道：读取不经 Web API（无账号、无速率配额、数据不出本机），也不直连 SQLite（版本脆弱、绕过 Zotero 的事务与缓存）。支持的 Zotero 下限为 **10**：写入能力实际从 8 开始，但把兼容线统一抬到 10 可以只测一条路径；低于 10 的版本探测到后在 UI 明确报告为不支持，而不是部分降级。

## Consequences

- Zotero 桌面程序必须在本机运行且开启 “Allow other applications on this computer to communicate with Zotero”，这是功能前提而非可选项。
- 所有写入都经过 Zotero 自己的授权对话框与 key 管理，插件不复刻一套权限系统；”始终允许“的 key 按 `Zotero-Server-ID` 落盘（0600）。
- Web API 专属能力（跨设备同步触发、公开群组免登录访问）成为明确的非目标。
