# 写授权差别化：Agent 写工具加 DSH 审批，UI 主动写操作不额外审批

## Status

accepted

## Considered Options

- 所有写操作（UI 与 Agent）都加 DSH 审批：被否决——UI 写操作（如“保存高亮”“新建分类”）的发起者就是用户本人，再弹一层 DSH 审批是双重确认，徒增摩擦且教用户无脑点允许。
- 所有写操作只靠 Zotero 原生授权：被否决——“始终允许”后 key 长期有效，Agent 在无人值守时可以静默改库，绕过了 DSH 对话里的可见性与审计。

## Decision

写入 Zotero 的两条路径差别化授权。**UI 路径**：右侧标签里用户点出来的写操作（保存高亮、更新条目、建集合、加笔记等）直接走 Zotero 原生授权对话框（Local API key），不再经过 DSH 审批。**Agent 路径**：模型调用的写工具（`add_item`、`update_item`、`save_highlights`、`add_note`、`create_collection`、`attach_pdf`）在宿主半执行前先经 DSH 审批面（`@deepseek-ai/dsh-user-approval` 的 `ctx.approval.request(...)`，会话审计与 `allowed-once` 语义由该服务持有），通过后再走同样的 Zotero 原生授权。只读工具不做 DSH 审批。

## Consequences

- Agent 写工具必须声明非并发安全（`isConcurrencySafe: () => false`），审批通过到 Zotero 写入之间不得假设状态未变。
- Zotero 授权被拒（`write_denied`）时两条路径都必须终止并不自动重试；DSH 审批拒绝同样终止且记录在会话日志。
- 高亮等“会话内暂存”操作不算写操作（不落库），只有显式保存才进入授权路径。
