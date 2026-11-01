# 开发状态与实施记录（0.2.0）

> **说明**：本文件是从项目主页迁移出来的详细开发记录，面向贡献者与审阅者，
> 保留实现注记、里程碑日志与真机验收的实质信息。项目概览见
> [README.md](../README.md)（英文）/ [README.zh-CN.md](../README.zh-CN.md)
> （中文）；实施规格与验收矩阵见
> [implementation-spec.md](implementation-spec.md) §5.1 与 §9；架构决策见
> [ADR 0001](adr/0001-local-api-only-zotero-10.md)、
> [ADR 0002](adr/0002-dsh-two-halves-webserver-single-right-tab.md)、
> [ADR 0003](adr/0003-differentiated-write-approval.md)。

## 当前状态总览

**M0 骨架 + M1 数据层 + M2/M5/M6 宿主服务与安全路由 + M2/M3/M8 的右栏标签
UI 与会话集成 + M4 PDF 阅读、全文/定位工具、会话高亮与保存高亮 + M7
DOI/arXiv 元数据导入、PDF URL 下载、本机安装探测/启动与 `zotero://` deep
link、`export_bib` 工作区写入与 `attach_pdf` 本地路径模式已落地。**
已完成并经 vitest 全量验证（436 测试 / 24 文件，fake Zotero HTTP 服务器回放
+ 纯 reducer/API/投影/组件渲染 + 注入 fake 的元数据网络层/文件系统/spawn
seam，全部通过；`npm run verify` 全绿）。

## 实现范围明细

- **领域契约**（`src/domain/model.ts`）：库/集合/保存搜索/条目/附件/注释/连接
  状态等共享类型，`ZoteroError` 错误码表，键/id 与查询参数的运行时校验（防注入），
  LIMITS（列表 50、Agent 默认 25/上限 100、面板累计 500、写批量 50、PDF 分块
  2 MiB/上限 256 MiB/缓存 4、全文预算 30k），Zotero 注释色板与会话高亮类型。
- **条目投影**（`src/domain/items.ts`）：摘要/详情/注释的纯函数投影，标题回退、
  creatorSummary、年份、venue、最佳 PDF、标签、BibTeX/RIS 本机路径剥离。
- **引文匹配与矩形几何**（M4，`src/domain/text.ts`）：NFKC/引号连字符归一、
  行尾断词合并、空白折叠与忽略空白回退、"start … end" 跨段、跨页引文匹配、
  按字宽比例的高亮矩形（PDF 用户空间 pt）、Zotero `sortIndex`、页范围解析；
  纯函数 22 个直测（含中文与页坐标）。
- **PDF 提取**（M4，`src/pdf/extract.ts`）：pdf.js legacy 构建（打包副本
  `lib/pdfjs/legacy/`，按需动态 import，`node_modules` 仅作开发回退）、页标签、
  `PdfStore` 按 path+mtime+size 的 LRU=4、扫描版提示、`not_pdf`/`file_missing`
  映射。
- **Zotero 客户端**（`src/zotero/client.ts` + `src/zotero/auth.ts`）：
  loopback-only 基地址校验、`GET /api/` 探测（`X-Zotero-Version`/
  `Zotero-Server-ID`，主版本 <10 报 `unsupported`）、错误映射、授权对话框
  （并发共享、一次性/记住 key、按 Server-ID 作废旧 key）、写请求头、上传
  URL 的 SSRF 校验；`fetch`/`clock`/`sleep` 可注入。读取路径不做写探测。
- **只读访问层**（`src/zotero/library.ts`）：检索分页（`q/qmode/tag/sort/
  direction/start/limit`）、集合经 `/collections/<key>/items/top`、保存搜索经
  `/searches/<key>/items`、`Total-Results`/`Link` 解析、按库版本缓存、详情/
  子件/注释读取、`exportText`（Zotero 自带 BibTeX/RIS 导出 + 本机路径剥离）、
  附件路径解析抽象（`resolveAttachmentPath`——PDF 文件路径的唯一来源）。
- **写门面**（`src/zotero/writes.ts`）：批量创建 ≤50（`Zotero-Write-Token`）、
  PATCH 412 重读重试一次、附件三步上传失败回滚。
- **宿主服务**（`src/host/`）：`ZoteroSession` 门面（+ M4 PDF 文件验证服务与
  会话高亮存储）、官方 credentials grant record 持久 KeyStore、视图事件 hub
  （viewSeq 单调、有界历史、订阅清理、`highlights` 状态型通知）。
  **PDF 文件安全**（`src/host/pdf.ts`）：文件路径仅由 `resolveAttachmentPath`
  针对「已校验 library+attachmentKey」获得（路由不接受任意路径）；确认附件是
  存储 PDF、`%PDF-` magic、256 MiB 上限；读取失败映射 `file_missing`/`not_pdf`；
  两次 Zotero 解析 + realpath 比对缓解符号链接替换竞态（有专门测试）；字节
  按范围分块读取（2 MiB），不整文件进 JSON；pdf.js 静态资源（cmaps/
  standard_fonts/wasm）按「kind 白名单 + 文件名白名单」服务，无路径遍历面。
- **安全路由**（`src/host/routes.ts`）：`/dsh-zotero` 下除 `health` 外全部经
  官方 `ctx.connection.requestRejection` 认证与信任门（401/403），写路由再校验
  method（405）、JSON content-type（415）、body 上限（413）与字段（400）。
  覆盖 status、libraries、collections、items 搜索、item 详情、children、
  annotations（含会话高亮）、export、SSE `/events`（上限 + Last-Event-ID 重放）、
  **`/pdf/info`、`/pdf/part`（2 MiB 分块）、`/pdfjs/<kind>/<file>` 静态资源**
  与写路由（含 **`/writes/highlights/save|clear`** UI 写路由——显式 UI 动作
  不经 DSH 审批，但走同一 Zotero 授权门面；clear 仅会话态，绝不删 Zotero
  注释）。无 `connection` 服务时受保护路由 503。
- **Agent 工具**（`src/tools/`，19 个）：只读/视图工具（`open_item` 支持
  PDF page/quote 定位，quote 失败报 `quote_not_found`；`show_items` 经 SSE 推
  导航意图）、**M4 工具 `read_fulltext`（页标记/印刷页码/预算与续读提示/扫描版
  提示）、`find_in_pdf`（物理页+页标签+上下文）、`highlight`（quote→rects，
  `save: true` 时先 DSH 审批）、`clear_highlights`（仅会话态）** + 写工具
  （`save_highlights` 与其余写工具一样先 `ctx.approval.request` 再走同一
  Zotero 授权门面，ADR 0003；注释字段与 Zotero 原生一致：annotationText/
  Comment/Color/PageLabel/SortIndex + pageIndex+rects 位置 JSON）。
- **元数据导入（M7）**（`src/metadata/` + `add_item`/`attach_pdf`）：
  - **标识符解析**：DOI（裸 DOI、`doi:` 前缀、doi.org/dx.doi.org 链接、尾部
    标点剥离）与 arXiv（新旧式 id、版本号、abs/pdf/html 链接、
    `10.48550/arXiv.*` DOI）→ 统一 `parseIdentifier`；无法解析即
    `invalid_input` 且**零网络**。
  - **元数据获取**：doi.org 内容协商（`Accept:
    application/vnd.citationstyles.csl+json`，20s 超时）→ CSL-JSON → Zotero
    字段（类型映射、JATS 抽象清洗、literal 日期/机构作者、按条目类型的容器
    字段）；arXiv Atom（export.arxiv.org）→ preprint 条目（分类进 tags、
    comment/journal_ref/已发表 DOI 进 extra、开放获取 PDF 链接）。404/非
    2xx/非 JSON 一律 `metadata_not_found`。
  - **SSRF 守卫下载**（`src/metadata/net.ts`）：仅 http(s)、拒绝携带凭据的
    URL；DNS 全地址解析后逐个分类，loopback/私网/link-local/CGNAT/组播/
    保留段（含 IPv4-mapped IPv6、IPv6 unique-local/链路本地/文档段）一律
    拒绝且**先于任何连接**；重定向手动跟随、逐跳复检（公网地址 302 到
    `127.0.0.1`/`169.254.169.254` 直接失败）；流式读取按 100 MiB 上限截断、
    60s 超时、`%PDF-` magic 校验（容忍发布商前置字节）。
  - **`add_item`**：支持结构化字段或 DOI/arXiv 标识符（可合并覆盖字段）、
    collections（键或名）、tags；**DSH 审批先于任何外部网络与 Zotero 写入**
    （拒绝即零请求）；DOI 去重（库内已有同 DOI → 返回既有 key，不创建）；
    arXiv PDF 自动附加（下载失败降级为 warning，条目照常创建，三步上传）。
  - **`attach_pdf`**：URL 模式经同一 SSRF 守卫下载（含本地路径与内联 base64
    共三种来源，单选校验；路径/网络读取都发生在审批之后），100 MiB / 60s /
    `%PDF-` / 重定向逐跳校验。
  - 全部外部请求只触达 doi.org、export.arxiv.org、arxiv.org 与调用方给定的
    PDF 链接，且每一跳都过守卫；测试全部用注入 fake，不访问真实外网。
- **右栏标签 UI（M2/M3/M4/M8）**（`src/client.tsx` + `src/client/`）：
  - **纯 store**（`client/store.ts`）：单标签内导航栈（Library / Agent Items /
    Item Detail / PDF Reader / Connection 路由），同页就地替换（reader 以文档
    为身份，翻页/高亮跳转就地替换不压栈）、返回不逐字回退、栈上限 30；
    `viewSeq` 去重；`highlights` 意图为状态型（记录 `lastHighlight` 供阅读器
    刷新）；300ms 搜索防抖的提交逻辑为纯 action（vitest 直测）。
  - **API client**（`client/api.ts`）：仅 shared `ROUTES` 相对 fetch；统一错误
    envelope（`{ error: { code, message } }` → `ApiError`）；AbortSignal 贯穿；
    SSE `connectViewEvents`（EventSource + `Last-Event-ID` 重连 + `seq` 严格
    递增去重 + 关闭清理，`addEventListener('view')` 兼容真实浏览器命名事件）；
    PDF info/part/asset 与 highlights save/clear 的 typed 端点；导出文本的
    浏览器 blob 下载。
  - **PDF Reader（M4，懒加载 chunk `client.pdf.js`）**（`client/pdf.ts` +
    `client/reader.tsx`，经官方 `require.async('./client.pdf.js')` 分包契约
    加载，普通文库首屏不下载 pdf.js）：pdf.js canvas + 文本层（worker 主线程
    内联，CMap/标准字体/wasm 经认证静态路由的 DataFactory）、页码输入/总页/
    上下页（就地替换路由）、缩放/适宽、印刷页标签、用户注释与 Agent 高亮
    （紫色）同层叠加与点击弹窗、注释侧栏（点击跳页）、加载进度/错误/扫描版
    提示、划选文本出现「引用到对话 / 提问」（引用文本 + 标题 + 物理页/页标签
    + item/PDF keys；引用走非破坏 `captureInsertion+insertText`）、会话高亮
    保存到 Zotero / 移除会话高亮（不删 Zotero 注释）、导航返回。Agent 高亮
    变更经 SSE `highlights` 通知实时刷新。
  - **Library 视图**：个人 + 群组库切换、分类树（展开/上级自动展开/计数）、
    保存搜索；元数据/everything 全文切换；5 种排序 × 升降方向；每页 50 Load
    more（累计 500 上限）；行显示类型/标题/作者·年份·期刊/PDF 徽章；选择
    （checkbox、Shift 范围、Cmd/Ctrl/Shift 点击行）；多选底栏 加入对话/提问/
    清除；加载/空/错误 + 重试。
  - **Item 详情视图**：作者、字段表（固定顺序）、摘要展开、分类/标签 chips、
    附件列表、笔记（DOMPurify 清洗，无 DOM 环境降级为纯文本投影，绝不裸渲染
    HTML）、PDF 注释列表（色块/摘录/页码，点击跳到阅读器对应页）；导出
    BibTeX/RIS（浏览器下载，宿主 export 路由已剥离本机路径）；Show in Zotero
    按钮禁用并标注「需宿主 deep-link 接口（后续里程碑提供）」，不伪造链接。
  - **连接状态页**：ready / not_running / api_disabled / unsupported / error
    分状态中文/英文指引（Zotero 10+、开启 Local API 的操作步骤），一键重新
    检查。
  - **外观与可访问性**：全部颜色/圆角/字体读取 DSW `--dsw-*` 主题变量（跟随
    DSH 明暗主题），窄右栏与 fullscreen 均可用，控件带 aria-label/
    aria-checked/aria-expanded、焦点环、Escape 关菜单、Enter 打开行。
- **会话集成（M8）**（`client/chat-draft.ts` + tab props）：
  - **官方接口（V-6 已消解）**：DSH `sidebar.right.pane.tab` 槽为
    `scope: "session"`，其 standardProps 含 `inputActions`（官方 InputActions
    面：`setDraft`（写草稿不发送）/`submit()`（queue 模式提交当前草稿）等）
    与 `sessionId`。证据：本机 0.2.1-rc.x 安装包 `dsh-cordis-client-runner`
    的 CLIENT_SLOT_API 槽位目录、`dsh-client-ui-session`（`sessionId`）、
    `dsh-client-ui-conversation`（`ctx.uiSession.provide({ props:
    ["inputActions"] })`，`SessionInputShell.actions`）。只读查阅，未复制
    代码。
  - **Add to chat**：把固定格式条目文本（或阅读器划选的 PDF 段落：标题 +
    物理页/页标签 + 引文）**加入**当前会话可编辑草稿且**不发送**；只走
    `captureInsertion+insertText` 非破坏路径（保留用户已输入内容），await
    真实 boolean 成功才提示已加入；插入面缺失、`insertText` 返回 false 或
    reject 时**不改动草稿**并提示失败——没有 `setDraft` 替换回退，不丢失
    用户输入。
  - **Ask**：`setDraft(问题+条目/引文)` 后 `submit()` —— queue 模式（不
    steer/不打断）；输入 phase 为 adjudicating/submitting 时按钮禁用。
  - **无会话面时**（无 session scope）：按钮禁用并提示原因；**不降级为
    剪贴板、不静默发送**。条目文本含 library/key/PDF key 结构化标记，与参考
    实现格式兼容。
  - **SSE open_item/show_items/highlights**：驱动右栏导航（open_item→详情/
    Reader 指定页，show_items→Agent Items 视图，highlights→阅读器高亮层
    刷新）；api + reducer 双层 `seq` 去重；标签卸载关闭流并中止在途请求。
- **i18n**：zh（默认）/en 词典经 DSH locale 注册，跟随宿主语言（阅读器文案
  双语齐全）。
- **桌面引导与工作区写入（M7 install/export 部分，自动化层完成）**：
  - **安装探测**（`src/zotero/install.ts`）：跨平台候选布局（macOS `.app`、
    Windows ProgramFiles/LOCALAPPDATA、Linux 包/flatpak/PATH），版本只从
    bundle 读取（`Info.plist`/`application.ini`）绝不猜测；未安装
    （`missing`）与未运行（探测 `not_running` + install `found`）分状态引导。
  - **启动与 deep link**（`src/zotero/desktop.ts`）：`zotero://select`/
    `open-pdf` URL 全部服务端构造（library/key/page 二次校验），打开经平台
    白名单命令（macOS `/usr/bin/open`、Windows `rundll32 url.dll,
    FileProtocolHandler`、Linux `xdg-open`）+ 参数数组，无 shell、客户端
    不能传命令/路径；Setup「Open Zotero」、详情与 Reader「Show in Zotero」
    完整接线，UI/线协议永不携带绝对安装路径（仅 tilde 化的 searched 列表）。
  - **`export_bib` 工作区写入**：可选 `path`（工作区相对、必须 `.bib`）经
    官方 `ctx.fs.resolve`/`writeText` + `ctx.workingDirectory.ensure` 写入；
    绝对路径/`..` 段/realpath 逃逸（符号链接）一律拒绝，默认
    `createIfAbsent` 不覆盖（`overwrite: true` 才走原子替换）；无官方服务
    或无会话目录时 fail closed 只返回文本；导出文本剥离 Zotero 本机路径。
  - **`attach_pdf` 本地路径模式**：与 URL/内联字节同审批序（拒绝→不读文件
    不落库），读取后统一 100 MiB/`%PDF-`/裸文件名校验。
  - **测试**：新增 `zotero-install`（21：候选布局/版本读取/missing 列表/
    spawn 白名单与 argv/`zotero_not_installed`/URL 构造与拒绝）、
    `host-desktop`（11：session 门面缓存/路由 fence 与校验/客户端走私字段
    无效/install wire 不泄路径/ready 时不探测）、`workspace-export`（17：
    路径安全含符号链接逃逸/默认不覆盖/后端守卫映射/工具审批序/attach path
    审批先行与 %PDF/文件名校验）。

## 真机只读验收（macOS，DSH Desktop 0.2.1-rc.5）

全程只读，未写真实 Zotero。插件经 desktop profile `link:` 安装载入（装载前
profile 已备份至
`/Users/hanxu/.dsh/profiles/desktop/backup-20261101-141702/`）；真实 health
200，无认证直连 `/status` 回 401（预期认证栅栏，非故障）；宿主 Cordis 晚绑定
修复后，右栏真实显示个人文库 803 条；元数据检索「Double-shock」返回 1 条，
全文短语「elusive BC8 carbon」metadata 模式 0 条、everything 模式 2 条；条目
详情与 PDF 注释打开正常；PDF（附件 FHPRDEEL）在右栏真实渲染 22 页，页码/
缩放控件可见；「Add to chat」按正确 item key（CR6G7I2U）与 PDF key 插入当前
会话**可编辑草稿且不发送**（验收用草稿已清理）。

已消解的验证点（对应规格 V 表，详见
[implementation-spec.md](implementation-spec.md) §5.1）：V-1 右栏 tab 槽装载
且 session-scope props 实际到达（Add to chat 的
`captureInsertion+insertText` 非破坏插入真实走通）；V-8 桌面 webServer
同源性——客户端 document-relative fetch/EventSource 全部命中宿主路由
（health 200、真实读取文库 803 条），无认证直连 401 即预期 fence；V-10
`require.async('./client.pdf.js')` 兄弟 chunk 在真机 boot graph 装载成功，
PDF 阅读器真实渲染（22 页文档）；V-6 的 Add to chat 半边（草稿可编辑、未
发送）真机确认，Ask 的 `setDraft+submit` 真实发送未触发（见下节）。

## 尚未经真机验证（当前仅自动化覆盖）

- Ask 的真实发送（为避免向外部模型发送测试消息而主动跳过）。
- 真实 Zotero 写入、授权对话框、高亮保存到 Zotero（写能力探测响应码与授权
  流程，V-3）；`/api/local/uploads` 上传端点（V-5）。
- Zotero 响应头形状的显式复核（V-2——库读取真机成功间接说明
  `Zotero-API-Version: 3` 被接受，头形状未单独记录）；`file/view/url` 返回
  形状的显式记录（V-4——PDF 真机渲染成功说明 `resolveAttachmentPath` →
  `file/view/url` 链路真实可用，children JSON 字段形状未单独记录）。
- Local API 导出格式支持（V-9）；工具 `output.render` ContentBlock 在真实
  会话中的形状（V-7，宿主晚绑定/服务 cycle 行为已有 `tests/host-mount.test.ts`
  以真实 cordis 固定）。
- M7 真实 doi.org 内容协商、arXiv Atom 与发布商 PDF 链接的实际行为（V-11——
  离线测试全部用注入 fake 回放记录的响应形状，未访问真实外网）。
- M7 install/deep-link/工作区：本机 Zotero 安装探测的候选布局命中、
  `/usr/bin/open -a` 与 `zotero://select|open-pdf` 在真实 Zotero 中的表现、
  官方 `ctx.fs`/`ctx.workingDirectory` 的 `createIfAbsent` 守卫与 display
  path 形状（V-12——Open Zotero/deep link 与真实工作区导出均未真机触发）。

全部写入测试只针对 fake 服务器与 fake fs seam，未对真实 Zotero 发起写操作；
真机验收全程只读（未授权、未写入、未做写能力 POST 探测）；Windows/Linux
未实机验证。

## 官方依据说明

路由认证、凭据记录、工具注册与审批按本机 DSH 0.2.1-rc.2 官方包
README/.d.ts/源码实现；Chat Draft/Ask 接面证据见会话集成一节（CLIENT_SLOT_API
槽位目录与 `dsh-client-ui-conversation`/`dsh-client-ui-session` 源码，只读
查阅）；M4 分包按 `dsh-client-modules` 已发布包的 chunk 契约（只读查阅）。
DSH 服务面以「本地结构化类型 + 防御式查找」接入；`defineTool` 以本地镜像
产出与官方一致的注册形状（详见 `src/host/services.ts` 与
`src/tools/define-tool.ts` 模块注释）。pdf.js 的 worker/CMap/字体/wasm 分发
方式与参考实现（zai-org/zcode-plugins `ui-plugins/zotero`，同一 DSH 面板
环境实测可用）一致：worker 内联主线程、数据经认证路由的 DataFactory。

## 桌面装载契约（0.2.1-rc.5 实测）与故障排除

对真实 Desktop（`app.asar` lib/main.js / dsh-desktop-host / dsh-client-modules
/ dsh-client-hmr / dsh-client-ui-open-in-app 源码，只读查阅 + 运行实例探测）
确认的装载契约，本插件的两侧实现与之对齐：

- **客户端半（浏览器侧）**：桌面端 SPA 页面文档为 `dsh-app://app/`，Electron
  壳的 protocol handler 把非静态路径（含 `/dsh-zotero/*`）转发到宿主
  webServer 并附带其自有认证 cookie（`forwardWebRequest`）；桌面 boot 另提供
  `globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: <hostOrigin> }`。
  因此客户端半的全部宿主调用（fetch/EventSource，覆盖 status、检索、PDF
  分块与 assets、写路由）都以 **document-relative 引用**发出——宿主路由键是
  绝对路径（注册用），浏览器引用按官方边界规则去首斜杠
  （`dsh-client-modules` 对 combo URL 的既有做法；官方
  `dsh-client-ui-open-in-app` fetch `open-in-app/apps`、`dsh-client-hmr`
  订阅 `plugins/events`）。页面不持有任何凭据、不直连 Zotero 23119。
- **宿主半（Node 侧）**：组合服务（`webServer`/`connection`/`tools`/
  `approval`/`credentials`/`fs`/`workingDirectory`）以兄弟 fiber 提供时，
  Cordis 只把服务暴露进声明了它的 fiber；`inject` 为空的插件在 apply 期读
  服务会抛 `cannot get property … without inject`。故全部会话能力经官方晚
  绑定 effect 挂载：`ctx.inject(['webServer', 'connection'], …)`（路由）、
  `ctx.inject(['tools'], …)`（工具）、`ctx.inject(['approval'], …)`（执行期
  审批引用：写工具每次执行读取，晚到即采用、缺失/解绑 fail-closed）、
  `ctx.inject(['credentials'], …)`（持久 KeyStore 生效，client 安全重建；
  解绑回内存不外带 key）、`ctx.inject(['fs', 'workingDirectory'], …)`
  （export_bib 真实落盘；解绑回纯文本）（官方 `dsh-host-open-in-app` 的
  必需对与 `dsh-client-modules` 的可选 `ctx.inject(["webServer"], …)` 同款）。
  每个 effect 返回自己的 disposer：服务 cycle 时由 Cordis 卸载重挂，路由与
  工具注册不重复（重名 (kind,path) 在官方 webServer 会抛错）；这些行为由
  `tests/host-mount.test.ts` 以真实 cordis 固定。
- **故障排除**：标签体能显示但连接卡提示「无法连接插件宿主路由」⇒ 宿主半
  路由未注册。保留的只读诊断工具：`node scripts/probe-desktop.mjs [port]`
  （端口缺省时经 lsof 自行发现运行中 dsh-desktop-host 的 loopback 监听）——
  对运行中的 Desktop 依次检查 `GET /dsh-zotero/health`（404 即本症状）、
  `/status`、HMR 图与插件 bundle URL，只发 loopback GET，不写 Zotero、不碰
  GUI。判读已在 0.2.1-rc.5 真机验收中确认：health 200 + 无认证 `/status`
  401 = 路由已注册且认证栅栏按预期工作。host 半需插件重新装载（重启 DSH）
  后生效；client 半的重建产物经 HMR 即时生效。

## 目录速览

| 路径 | 内容 |
| --- | --- |
| `docs/implementation-spec.md` | 完整实施规格：功能清单、DSH/Zotero 契约、测试 seams、里程碑验收矩阵、非目标 |
| `docs/adr/` | 三条架构决策（Local API+Zotero 10 / 双半+webServer+右栏单标签 / 差别化写审批） |
| `src/index.ts` | 宿主半：配置 schema + HostRuntime 组装（routes + tools） |
| `src/client.tsx` | 客户端半入口：tab 注册、session-scope props、SSE 接入、路由视图、reader chunk 懒加载（`require.async`） |
| `src/client-pdf.tsx` | 懒加载 chunk 入口（`client.pdf.js`）：pdf.js + 阅读器，官方包内 chunk 契约注册 |
| `src/client/store.ts` | 纯 reducer：导航栈/viewSeq 去重/highlights 状态意图/查询防抖提交/视图数据状态（vitest 直测） |
| `src/client/api.ts` | 相对 fetch 客户端：错误 envelope、AbortSignal、SSE 重连去重、路径构建、PDF info/part/assets、highlights 写路由、导出下载 |
| `src/client/chat-draft.ts` | Chat Draft/Ask 投影（条目 + PDF 划选引文）与官方 `inputActions` 面的防御式接入 |
| `src/client/pdf.ts` | 阅读器 chunk 内的 pdf.js 胶水：分块下载、主线程 worker、认证路由 DataFactory、视口矩形换算 |
| `src/client/reader.tsx` | PDF 阅读器视图（canvas/文本层/页导航/缩放/注释与高亮层/侧栏/划选工具条/弹窗） |
| `src/client/views.tsx` | Library/Agent Items/Item Detail/连接状态视图（reader 在 chunk 内） |
| `src/client/i18n.ts` | zh/en 词典 |
| `src/client/styles.ts` | DSW 主题变量样式（注入一次，含阅读器/文本层/高亮层样式） |
| `src/client/icons.tsx` · `src/client/ui.tsx` | 内联 SVG 图标与共享 atoms/hooks |
| `src/shared/protocol.ts` | 两半共享的路由表、wire 类型、传输上限与事件形状（含 M4 PDF/高亮类型） |
| `src/host/services.ts` | DSH 服务面的本地结构化类型 + 防御式查找（官方 open-in-app 模式） |
| `src/host/session.ts` | `ZoteroSession` 门面：组合 + 配置热更新重建 + 会话高亮（create/find/clear/save） |
| `src/host/pdf.ts` | PDF 文件验证服务（路径仅经 `resolveAttachmentPath`、双解析 realpath 防符号链接竞态、magic/大小校验、2 MiB 范围读、资产白名单） |
| `src/host/highlights.ts` | 会话 Agent 高亮存储（id 序、按 ids/key 增删查、savedAs 标记） |
| `src/host/keystore.ts` | 官方 credentials grant record 持久 KeyStore |
| `src/host/routes.ts` | 认证安全路由 + SSE `/events` + M4 PDF 路由 + UI 高亮写路由 |
| `src/host/respond.ts` | fence 门、JSON 应答、错误 envelope、受限 body 读取 |
| `src/host/events.ts` | 视图事件 hub（viewSeq/有界历史/订阅清理） |
| `src/tools/` | Agent 工具 ×19（defineTool 镜像 + 注册 + 写工具审批包装 + M4 PDF 工具 + M7 `add_item`/`attach_pdf`） |
| `src/metadata/metadata.ts` | M7 元数据导入：标识符文法、CSL-JSON/Atom → Zotero、下载预算与 `%PDF-`/文件名清洗 |
| `src/metadata/net.ts` | M7 SSRF 守卫 fetch：DNS 全地址分类、手动重定向逐跳复检、公网 http(s) 强制 |
| `src/pdf/extract.ts` | pdf.js legacy Node 提取（按需动态 import 打包副本）+ PdfStore LRU + `%PDF-` 检查 |
| `src/domain/model.ts` | 领域类型、错误码、LIMITS、注释色板与运行时校验（M1/M4） |
| `src/domain/text.ts` | 引文匹配与高亮矩形几何纯函数（M4） |
| `src/domain/items.ts` | 条目摘要/详情/注释投影与导出剥离纯函数（M1） |
| `src/zotero/client.ts` + `src/zotero/auth.ts` | Local API 客户端：探测/授权/写入/上传（M1） |
| `src/zotero/library.ts` | 只读访问层：检索/分页/详情/注释/导出（M1） |
| `src/zotero/writes.ts` | 写门面：批量/PATCH/三步上传（M1，测试覆盖） |
| `tests/` | vitest 单测（fake Zotero HTTP 服务器回放 + reducer/API/投影/组件渲染 + M4 文本/提取/路由/工具 + M7 元数据/守卫/导入/安装探测/工作区写入 + 真实 cordis 晚绑定，436 用例 / 24 文件） |
| `scripts/` | 客户端双入口打包、pdf.js 资产复制与冒烟脚本 |
| `lib/pdfjs/`（构建产物） | 随发行物分发的 pdf.js 运行时资产：legacy 构建 + cmaps/standard_fonts/wasm + 许可文件 |
| `LICENSE` / `NOTICE` / `THIRD_PARTY_NOTICES.md` | Apache-2.0 与第三方材料登记（含 M1/M4 移植归属、DOMPurify 与 pdfjs-dist 登记） |
