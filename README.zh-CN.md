<p align="center">
  <img src="icon.svg" width="72" alt="DSH Zotero 插件图标">
</p>

# DSH Zotero 插件

[English](README.md) | **简体中文**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-%40hanxu131%2Fdsh--zotero--0.2.0-CB3837.svg)](https://www.npmjs.com/package/@hanxu131/dsh-zotero)
[![DSH Desktop](https://img.shields.io/badge/DSH_Desktop-%E2%89%A5_0.2.1--rc.1%2C_%3C_0.3.0-blue.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Zotero](https://img.shields.io/badge/Zotero-10%2B-CC2936.svg)](https://www.zotero.org/)

面向 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)
的独立 [Zotero](https://www.zotero.org/) 插件：在 DSH 右侧标签内访问与操作本机
Zotero 文库——检索、条目详情、带注释与高亮的 PDF 阅读器、引文导出——并提供
19 个 Agent 工具，让对话助手能以你的名义完成同样的工作。

## 功能

- **文库浏览**——个人与群组文库、分类树、保存搜索、排序与分页。
- **检索**——元数据（`titleCreatorYear`）与全文（`everything`）两种模式，
  标签过滤，结果排序。
- **条目详情**——作者、字段、摘要、标签、子笔记（经清洗）、附件与 PDF
  注释（点击跳页）。
- **PDF 阅读器**——右栏内渲染，页码导航、缩放、印刷页标签、用户注释与
  Agent 高亮同层叠加；划选文本可作为引用插入对话。
- **会话集成**——*加入对话*把条目或 PDF 划选段落写入当前草稿且不发送；
  *提问*就所选条目提交问题。两者均走 DSH 官方会话输入接口。
- **文献导出**——经 Zotero 自带导出器生成 BibTeX/RIS，浏览器下载或写入
  工作区 `.bib` 文件。
- **元数据导入**——从 DOI 或 arXiv 标识符创建条目（审批后从
  doi.org / arXiv 获取），可选下载 PDF。
- **Deep link**——经 `zotero://` 链接在 Zotero 中打开条目或跳到 PDF 页
  （服务端构造，平台白名单命令）。
- **界面语言**——简体中文与英文，跟随 DSH 宿主语言。

## 要求

- DSH 桌面版 `>=0.2.1-rc.1 <0.3.0-0`
- [Zotero](https://www.zotero.org/) 10 及以上，且开启本地 API（见快速开始）
- 插件按跨平台设计；目前仅 macOS 经真机验证（见
  [验证状态](#验证状态)）。

## 安装

从 npm 安装（推荐）：

```bash
dsh plugin --profile desktop add @hanxu131/dsh-zotero
```

从本地源码安装（link 方式；映射见
[cordis.patch.yml](cordis.patch.yml)）：

```bash
dsh plugin --profile desktop add link:/path/to/zoteroplugin-dsh
```

安装后**完全退出并重启 DSH**，插件宿主半（Agent 工具与路由）才会装载。
卸载/禁用走 DSH 插件管理页。

## 快速开始

1. 在 Zotero 中打开 **设置 → 高级**，勾选
   **"Allow other applications on this computer to communicate with
   Zotero"**，并保持 Zotero 运行。
2. 按上文方式安装插件，然后**完全退出并重启 DSH**。
3. 在 DSH 右栏 guide 页打开 **Zotero 文库** 入口。标签首先显示连接状态；
   若 Zotero 不可达，会给出上述设置的分步指引。
4. 浏览、检索、阅读。读取不会改动文库。**Agent 发起的写入**经过两道门：
   先经 DSH 审批提示，首次再经 Zotero 自身的授权对话框。你在右栏中明确
   执行的写操作（如保存高亮）跳过审批提示，但仍走 Zotero 授权。

界面语言（中文 / English）跟随 DSH 宿主语言。

## 配置

插件只有一个设置项：

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `localApiBaseUrl` | `http://127.0.0.1:23119` | Zotero 本地 API 基地址。仅接受 loopback 地址，其他主机一律拒绝。 |

默认值写在 [cordis.patch.yml](cordis.patch.yml)（把插件挂载进 DSH profile
的清单）里，此外无需任何配置。

## Agent 工具

共 19 个工具注册给 DSH Agent。读取类不改动文库；视图类驱动右栏 UI；写入类
需先经 DSH 审批提示，首次再经 Zotero 授权对话框。

**只读**

| 工具 | 说明 |
| --- | --- |
| `list_collections` | 列出文库的分类树与保存搜索。 |
| `search_library` | 检索条目（元数据/全文模式），支持标签过滤、排序与分页。 |
| `get_item` | 获取单个条目的完整元数据：作者、字段、摘要、标签、附件、笔记。 |
| `search_annotations` | 按文本或标签检索条目的 PDF 注释。 |
| `cite` | 生成引用（APA）或返回 BibTeX 条目。 |
| `read_fulltext` | 读取 PDF 提取文本，带页标记与单次字符预算。 |
| `find_in_pdf` | 在 PDF 中查找词句，返回物理页、页标签与上下文。 |
| `export_bib` | 导出 BibTeX/RIS 文本；可经审批写入工作区相对路径的 `.bib` 文件。 |

**视图（驱动右栏 UI）**

| 工具 | 说明 |
| --- | --- |
| `open_item` | 在面板中打开条目或其 PDF，可定位到指定页或引文。 |
| `show_items` | 在面板中展示条目列表。 |
| `highlight` | 在阅读器中高亮引文段落（会话高亮）；`save: true` 同时写入 Zotero（写审批）。 |
| `clear_highlights` | 仅移除会话高亮；绝不删除 Zotero 中的注释。 |

**写入（DSH 审批 + Zotero 授权）**

| 工具 | 说明 |
| --- | --- |
| `save_highlights` | 把会话高亮保存为 Zotero 注释。 |
| `add_item` | 以结构化字段或 DOI/arXiv 标识符创建条目，可选下载并附加 PDF；自动检测重复 DOI。 |
| `update_item` | 更新已有条目字段。 |
| `add_note` | 为条目添加子笔记。 |
| `create_collection` | 创建分类。 |
| `attach_pdf` | 为条目附加 PDF：本地路径、经 SSRF 守卫的 URL 或内联字节。 |
| `authorize_writes` | 请求或确认 Zotero 写授权。 |

## 安全

- **仅 loopback。** Zotero 基地址强制校验为 loopback 地址；客户端不持有任何
  凭据、不直连 Zotero——全部流量经由插件在 DSH 内的认证宿主路由。
- **Agent 写入双道门。** Agent 发起的写操作先经 DSH 审批提示，再经 Zotero
  自身授权对话框（见 [ADR 0003](docs/adr/0003-differentiated-write-approval.md)）。
  右栏中明确的 UI 动作跳过审批提示，但仍走同一 Zotero 授权。
- **文件安全。** PDF 路径仅来自经 Zotero 解析的附件键——路由不接受任意
  路径；双重解析加 `realpath` 比对缓解符号链接替换竞态；读取前校验
  （`%PDF-` magic、大小上限）并分块读取。`export_bib` 只能写工作区相对的
  `.bib` 文件；绝对路径、`..` 段与符号链接逃逸一律拒绝。
- **SSRF 守卫。** 外部下载（DOI/arXiv 元数据、PDF URL）仅允许公网
  http(s) 地址；DNS 解析结果逐地址分类，loopback/私网/link-local 段在
  连接前即拒绝，重定向逐跳复检，并带大小、超时与文件 magic 限制。

## 验证状态

如实概述；完整开发与验收记录（中文）见
[docs/development-status.md](docs/development-status.md)。

- **自动化**：仓库自带 vitest 测试套件（fake Zotero HTTP 服务器，注入
  文件系统/spawn/网络 seam）与冒烟脚本；`npm run verify` 一次跑完
  typecheck、测试、构建与冒烟。
- **真机已验证（只读）**：macOS + DSH Desktop 0.2.1-rc.5——对真实 Zotero
  文库完成了文库浏览（803 条）、检索、条目详情、PDF 渲染与草稿插入，全程
  未写入文库。
- **仅自动化覆盖、尚未真机验证**：真实 Zotero 写入与授权对话框、*提问*的
  实际发送、DOI/arXiv 外网导入、`zotero://` deep link、真实工作区导出、
  写上传端点。
- **Windows/Linux**：未实机验证。

## 开发

需要 Node `^22.19.0 || >=24`。

```bash
npm install
npm run verify     # typecheck && test && build && smoke
npm run watch      # 客户端半增量打包
```

单独步骤：`npm run typecheck`、`npm run test`、`npm run build`、
`npm run smoke`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/implementation-spec.md](docs/implementation-spec.md) | 完整实施规格：功能清单、DSH/Zotero 契约、测试 seam、里程碑验收矩阵、非目标。 |
| [docs/adr/](docs/adr/) | 三条架构决策：Local API + Zotero 10（[0001](docs/adr/0001-local-api-only-zotero-10.md)）、双半插件 + webServer + 右栏单标签（[0002](docs/adr/0002-dsh-two-halves-webserver-single-right-tab.md)）、差别化写审批（[0003](docs/adr/0003-differentiated-write-approval.md)）。 |
| [docs/development-status.md](docs/development-status.md) | 详细开发记录：实现注记、里程碑日志、真机验收状态、装载契约与故障排除（中文）。 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | Apache-2.0 声明与第三方材料登记。 |

### 故障排除

- 标签能显示但提示「无法连接插件宿主路由」：宿主半需要插件重新装载——
  完全重启 DSH。
- 连接状态显示 Zotero 不可达：确认 Zotero 10+ 正在运行，且已开启本地 API
  设置（快速开始第 1 步）。
- `node scripts/probe-desktop.mjs [port]` 是只读诊断工具，检查运行中
  Desktop 的 `/dsh-zotero/health`、`/status` 与 bundle URL（仅 loopback
  GET 请求）。

## 许可

[Apache-2.0](LICENSE)。数据层与元数据导入的部分模块移植并改写自 ZCode 官方
Zotero 插件（[zai-org/zcode-plugins](https://github.com/zai-org/zcode-plugins)
`ui-plugins/zotero`，Apache-2.0，已标注修改）；其余为原创。详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
