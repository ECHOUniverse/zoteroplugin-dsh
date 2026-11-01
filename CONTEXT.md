# DSH Zotero Plugin

面向 DSH 的独立 Zotero 插件，让用户在 DSH 内访问并操作自己的 Zotero 文库。

## Language

### 文库与数据

**Zotero Library**:
用户的个人文库或群组文库，不是 SQLite 文件。
_Avoid_: 数据库、zotero.sqlite、本地存储

**Local API**:
Zotero 桌面程序提供的本机读写接口，是插件访问 Zotero 的唯一数据来源。
_Avoid_: Web API、直连数据库

### 界面

**Right Sidebar Tab**:
DSH 中承载 Zotero 功能的右侧标签面板。
_Avoid_: 侧边栏、侧栏面板、Sidebar

### 检索

**Search**:
在 Zotero Library 中查找内容的统称，分为元数据检索与全文检索两种模式，通过模式区分。
_Avoid_: 查询、查找

**Metadata Search**:
基于 Zotero 元数据的检索模式。
_Avoid_: 条目检索

**Full-text Search**:
基于 everything 的全文检索模式。
_Avoid_: 全文搜索

### 会话

**Chat Draft**:
当前 DSH 会话中尚未发送、可编辑的输入内容，Add to chat 把 Zotero 条目或引用加入这里。
_Avoid_: Message、消息

**Ask**:
把用户问题与相关 Zotero 条目或引用发送到当前会话的动作，不同于仅加入 Chat Draft。
_Avoid_: Add to chat、发送消息

### 目标

**Reference Parity**:
首版目标：用户可见功能对齐 ZCode 官方 Zotero 插件，涵盖检索、详情、PDF、注释、高亮、Agent 交互与写入。
_Avoid_: 复刻、完全对齐
