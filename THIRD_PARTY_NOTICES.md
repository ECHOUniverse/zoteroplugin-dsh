# Third-Party Notices

本文件登记 `@hanxu131/dsh-zotero` 发行物涉及或参考过的第三方材料。下表按「已移植
代码」「已随发行物分发」「设计参考／后续将引入」三类区分，避免虚构依赖。

## 已移植代码（Apache-2.0，含修改）

M1 数据层的部分宿主无关模块移植并改写自 ZCode 官方 Zotero UI 插件的参考实现：

| 本项目文件 | 移植自（上游文件） | 主要修改 |
| --- | --- | --- |
| `src/domain/model.ts` | `ui-plugins/zotero/src/contract.ts`（`ZoteroError`、`KEY_PATTERN`、`libraryPrefix`、部分类型形状） | 重命名 `ZoteroStatus`→`ConnectionStatus`；新增 `unsupported` 连接状态与 `unsupported_version` 错误码（Zotero 10+ 下限）；新增多标签 `ItemQuery`、运行时校验函数、`Total-Results`/`Link` 解析；LIMITS 按 DSH 面板重新取值 |
| `src/domain/items.ts` | `ui-plugins/zotero/src/domain/items.ts`；`stripLocalPaths` 来自同项目 `src/zotero/library.ts` | `creatorSummary` 改名 `creatorSummaryOf`；抽出 `noteInfo`/`attachmentInfo` 构造器；`buildItemDetail` 改为纯函数；附件类型不携带本机路径（V-4 未证实） |
| `src/zotero/client.ts` | `ui-plugins/zotero/src/zotero/client.ts`（探测状态机、授权/写入流程、HTTP 错误映射） | `fetch`/`now`/`sleep` 可注入；`KeyStore` 插件化（上游硬编码 key 文件）；`probeWrites` 与 `probe` 解耦（读取路径不做写探测）；新增 `unsupported`/`unsupported_version`（Zotero 10+）；严格 loopback URL 校验 |
| `src/zotero/library.ts` | `ui-plugins/zotero/src/zotero/library.ts`（读取流程、版本记账、集合名解析） | 查询经 `domain/model.ts` 归一化校验（多标签、注入防护）；`Total-Results`/`Link` 解析内联；详情投影移入纯函数 `buildItemDetail`；附件路径解析保留为唯一文件路径接缝 |
| `src/zotero/writes.ts` | `ui-plugins/zotero/src/zotero/writes.ts`（批量/PATCH/三步上传流程） | key 经 client 的 `KeyStore` 取得；缓存失效改经 `ZoteroLibrary.invalidate`；上传 URL 校验集中在 `ZoteroLocalClient.upload` |
| `src/client/store.ts` | `ui-plugins/zotero/ui/store.ts`（导航栈模型：同页就地替换、栈上限、Agent 视图意图压栈） | 纯 reducer（无模块级可变快照）；`viewSeq` 去重保留；资源缓存改为 store 内按 viewKey 的加载/空/错误状态；查询防抖（300ms）的提交逻辑抽为纯 action；路由面改为本插件的单标签 IA（library/items/item/reader/settings），reader 路由以文档为身份（页码/高亮变更就地替换）并新增 `highlights` 状态型意图 |
| `src/client/views.tsx`（部分）与 `src/client/ui.tsx`（部分） | `ui-plugins/zotero/ui/Library.tsx`、`ItemView.tsx`、`Setup.tsx`、`common.tsx`（列表行/多选 Shift 范围/菜单树/防抖搜索/详情分区/注释列表等交互逻辑与布局构思） | 数据流重写为相对路径 fetch + SSE（上游为宿主资源桥）；样式改用 DSW 主题变量；Ask/Add to chat 经 DSH `inputActions` 官方面（上游为宿主 `sendMessage`/`updateModelContext`）；导出走本插件 export 路由 + 浏览器下载；Setup 页按本插件连接状态机（无安装探测/移交 Agent） |
| `src/client/chat-draft.ts`（`itemRef` 行格式） | `ui-plugins/zotero/ui/chat.ts`（`itemRef`/`addItemsToContext`/`askAboutItems` 的文本形状，保持参考兼容） | 载荷面从宿主桥改为 DSH `inputActions.setDraft/submit`（queue）；`addToChat` 增加非破坏性插入优先与替换回报 |
| `src/domain/text.ts` | `ui-plugins/zotero/src/domain/text.ts`（M4 引文匹配与矩形几何全量：`buildPage`/`normalize`/`findInPage`/`findQuote`/`rectsFor`/`sortIndex`/`parsePages`/`searchPages`） | `Rect` 类型改自本插件 `domain/model.ts`；`pageIndexFor` 自上游 `app/session.ts` 移入本纯函数模块；文档重排，算法逻辑保持等价 |
| `src/pdf/extract.ts` | `ui-plugins/zotero/src/pdf/extract.ts`（pdf.js legacy Node 提取、CMap 目录定位、PdfStore LRU、`isPdf`） | pdf.js 改为按需动态 `import()`（打包副本 `lib/pdfjs/legacy/`，`node_modules` 仅作开发/测试回退），使宿主半模块图不加载 pdf.js 且 npm 包自带资源；LIMITS 取自本插件 `domain/model.ts`；worker/CMap 接线等价 |
| `src/host/highlights.ts` + `src/host/session.ts`（高亮/保存流程） | `ui-plugins/zotero/src/app/session.ts`（`highlight`/`findHighlights`/`clearHighlights`/`saveHighlights` 的引文定位→矩形→Zotero 注释字段流程，`COLORS` 表） | 会话态改为插件进程级 `HighlightStore`（上游为每会话对象）；保存经本插件 `ZoteroWrites` 门面（ADR 0003 的 DSH 审批在工具层）；色板移入 `domain/model.ts`；SSE `highlights` 通知替代上游 state.json 轮询 |
| `src/client/pdf.ts`、`src/client/reader.tsx` | `ui-plugins/zotero/ui/pdf.ts`、`ui/Reader.tsx`（阅读器视图结构：canvas+文本层、按可见性渲染、注释/高亮叠加、划选工具条、弹窗、侧栏） | 数据面改为本插件 `/dsh-zotero` HTTP 路由（pdf 字节按 2 MiB 分块、CMap/字体/wasm 走认证静态路由，上游为宿主资源桥）；保存/移除走本插件 UI 写路由 `writes/highlights/*`（显式 UI 动作，无 DSH 审批）；刷新走 SSE `highlights` 推送；无 deep link（Show in Zotero 省略）；以独立懒加载 chunk `client.pdf.js` 分发（官方 require.async 分包契约） |
| `src/metadata/metadata.ts` | `ui-plugins/zotero/src/metadata/metadata.ts`（M7：DOI/arXiv 标识符文法、CSL-JSON→Zotero 与 arXiv Atom→Zotero 映射、文件名清洗与下载/流式形状） | 下载改经本插件 `metadata/net.ts` 的 SSRF 守卫 `guardedFetch`（手动重定向逐跳复检、DNS 全地址分类——上游直接信任公开 URL）；超时/上限走本插件 `LIMITS`；错误经本插件 `ZoteroError`；fetcher/lookup 可注入以支持离线测试 |
| `tests/helpers/make-pdf.ts` | `ui-plugins/zotero/test/pdf-fixture.mjs`（无依赖的最小 PDF 生成器思路） | 移植为 TypeScript，文本内容为本项目自拟的两页样例与扫描版样例 |

上游：[zai-org/zcode-plugins](https://github.com/zai-org/zcode-plugins)
`ui-plugins/zotero`（仓库根 LICENSE 为 Apache License 2.0；注意其
`ui-plugins/zotero/package.json` 元数据声明为 MIT，以仓库 LICENSE 为准归属）。
版权属上游作者；本项目在这些文件头部以 "Attribution" 段落标注来源与修改。上游
许可证全文见 <https://www.apache.org/licenses/LICENSE-2.0>（与本项目 LICENSE 同文）。

## 已随发行物分发

| 依赖 | 许可证 | 用途与分发方式 |
| --- | --- | --- |
| `dompurify`（^3.2.4） | Apache-2.0 **或** MPL-2.0（双许可，取 Apache-2.0） | 条目详情笔记 HTML 的浏览器端清洗（M3）。构建期经 esbuild 打包进 `lib/client.js` 随发行物分发。上游：<https://github.com/cure53/DOMPurify>，版权 cure53 与贡献者。其 Apache-2.0 许可文本与本项目 LICENSE 同文；MPL-2.0 备选文本见 <https://www.mozilla.org/MPL/2.0/>。 |
| `pdfjs-dist`（6.4.299，精确锁定） | Apache-2.0 | PDF 渲染与文本提取（M4）。分发方式：浏览器侧经 esbuild 打包进懒加载 chunk `lib/client.pdf.js`；Node 侧 legacy 构建（`pdf.mjs`/`pdf.worker.mjs`）与 `cmaps`/`standard_fonts`/`wasm` 数据目录由 `scripts/copy-pdfjs.mjs` 复制进 `lib/pdfjs/`（随 npm `files` 的 `lib` 分发，其内附 `LICENSE` 与 wasm 组件许可文件）。上游：<https://github.com/mozilla/pdf.js>，版权 Mozilla 与贡献者；许可全文见 <https://www.apache.org/licenses/LICENSE-2.0> 及 `lib/pdfjs/LICENSE`。 |

（`react`、`@deepseek-ai/cordis` 等运行时库由 DSH 宿主的模块表在运行时提供，
不在本包内分发；`esbuild`、`typescript`、`vitest`、`pdfjs-dist`（构建期资源来源）等
仅为开发依赖，运行时不解析开发机 `node_modules`。）

## 设计参考（未复制代码）

| 材料 | 许可证 | 说明 |
| --- | --- | --- |
| DeepSeek Harness（`@deepseek-ai/dsh-*` 0.2.1-rc.2，聊天接面证据取自本机 0.2.1-rc.x 安装内包） | MIT | 插件运行时宿主。本项目引用其公开的 `.d.ts` 类型契约与 README（`dsh-client-modules`、`dsh-host-webserver`、`dsh-client-ui-sidebar-right`、`dsh-user-approval`、`dsh-tools`、`dsh-package-manifest`），未分发其代码。Chat Draft/Ask 依据（V-6，只读查阅未复制代码）：`dsh-cordis-client-runner` 的 CLIENT_SLOT_API 槽位目录（`sidebar.right.pane.tab` 为 `scope: "session"`，standardProps 含 `inputActions`/`sessionId`）、`dsh-client-ui-session`（`sessionId` prop）与 `dsh-client-ui-conversation`（`ctx.uiSession.provide({ props: ["inputActions"] })`，`SessionInputShell.actions` 的 `setDraft`（写草稿不发送）/`submit()`（queue 模式提交））。M4 分包依据（V-10，只读查阅 `dsh-client-modules` 0.2.1-rc.2 已发布包源码）：`ClientBundleRegistration.chunk` + `ClientBundleRequire.async`（chunk 文件名须匹配 `client.<name>.js`；`importChunk` 由 boot graph 行派生兄弟 chunk URL）——本插件的 `client.pdf.js` chunk 与 `require.async('./client.pdf.js')` 调用按此官方契约实现。 |
| Zotero 官方文档（Local API / Web API v3） | — | 端点语义、写入授权（Zotero 10+）、分页与版本头的权威依据：<https://www.zotero.org/support/dev/web_api/v3/local_api> 与 `/basics`。 |

维护约定：每当 `package.json` 新增会进入发行物（`files` 列表）的依赖时，必须在本文件
补登记其许可证并附上游许可文本；仅开发依赖与宿主运行时提供的依赖不在此列。
