# 交接文档：手机轻量版（MiniMapStatusMobile）渲染回归排查

> 写给下一个会话。请先通读本文再动手；遵守全局 AGENTS.md（中文回复、手术式修改、git 提交备注短 hash）。
> 项目根目录：`D:\Project\MiniMapStatus`。

---

## 0. 勘误（覆盖前版交接文档的错误结论，以此为准）

**前版文档把「探查 A（8 页签完整渲染）」当成了新版修复后的状态——这是错的。**

用户澄清：探查 A 时导入的是**手机原版**（未修改的 8/26 基线），探查 B（页签缩水到只剩「周云」）才是本次任务产出的新版。因此：

- 8 页签完整渲染（小地图/大地图/周云/Ghost/伯兰/列夫/瑟维/据点 + 行动选项）= **手机原版的正确行为**，是回归基线；
- 新版在同一楼层上页签缩水 = **新版渲染回归 bug**，首要嫌疑就是前会话对渲染层的改写（见 §2 审计），不是什么"两次渲染竞态"。

前版文档中的 H1/H2/H3 假设框架作废，不要再沿用。

## 1. 手机原版捕获逻辑改动审计（用户责成如实备注）

用户要求：**最新版除独立大地图外，一切正文捕获路径都不需要**。以下是对"正文捕获→渲染"链路逐环节的如实审计（对照 `备份/regex-美化状态栏[手机专用].json` 解包原版）：

### 1.1 未改动的部分（原版捕获核心，完好）

- `extractLastBlock` / `extractMaintext` / `extractStatusBlock` / `cleanYamlContent` / `attemptYamlFix` / `updateYamlDataSource` / `updateMaintext` / `reRenderStatusBar` / `renderPageFromMessage` 的原有提取调用逻辑——**一字未改**（仅在 renderPageFromMessage 里追加了两行 MMS.messageText/floorId 接线，不碰提取本身）。
- js-yaml 解析流程未动。

### 1.2 改动的部分

| 环节 | 改动 | 性质 |
|---|---|---|
| `findRegex`（构建产物里） | 捕获组 `([\s\S]*?)` → 裸 `[\s\S]*?`（commit 67b7842，修 $1 注入 bug） | 匹配语义等价，但确实动了捕获表达式 |
| **`renderCharacterTabs`** | **整体重写**：原版用 `findFieldByKeywords(rootData, ['用户','角色','列表',...])` 动态探测角色列表键（真机 YAML 的「用户列表」键可命中）；新版改成只显式认 `角色列表/小地图/大地图/人物` 四个固定键 + 自定义对象模块透传，**旧版关键词探测只在 entries 为空时兜底**——模块存在时「用户列表」键的角色会全部丢失 | **超出原版行为的改写，页签缩水的首要嫌疑** |
| `renderAll` | 加了 `window.MMS.injectBigMapArt(rootData)` hook：渲染输入被深拷贝+大地图合成包装 | 渲染路径新增环节 |
| `createCharacterCard` | 加立绘双栏（原版是纯属性列表卡片） | 视觉层新增 |
| `createAttributeItem` | 徽章折叠从"第 6 个起隐藏"改为字符数阈值折叠；地图分支加开关判断 | 行为层替换 |

### 1.3 添油加醋审查结论（如实）

前会话为验证自己写的新功能，harness（`integration-test/mobile-harness.html`，42 项断言）**是按新版功能清单写的自我验证**，mock YAML 还用了「角色列表」键——它证明不了"保持手机原版行为"，反而掩盖了 renderCharacterTabs 重写对原版探测逻辑的破坏。此外渲染层从桌面版搬来的"模块化 entries 收集、自定义模块透传"等逻辑超出了用户点名的需求范围（用户只点名要：独立大地图、地图管理、图片管理、性能优化）。

## 2. 下个会话的任务（用户指令，按此执行，勿自由发挥）

1. **以手机原版为基线重写断言网页**：
   - 原版基线在 `备份/regex-美化状态栏[手机专用].json`（370814 字节，8/26 原版，解包即原版 HTML）；
   - 断言标准 = **原版在同一 mock 楼层上的渲染行为**（页签集合、正文管线、行动选项），不是 PC 桌面版完整功能；
   - 具体：用原版解包 HTML 和新版解包 HTML 跑**同一份 mock 楼层数据**（mock 数据键名用真机实测的「用户列表」），先记录原版输出作为预期，再断言新版不回归；
   - 现 harness 的"新版功能断言"可保留为附加组，但不得作为通过标准。
2. **修复 renderCharacterTabs 回归**：恢复原版的 `findFieldByKeywords` 动态探测角色列表逻辑为**主路径**（「用户列表」「角色列表」等键都要能命中），小地图/大地图卡片只作为**附加条目**拼在角色列表之前（原版行为里没有这两个卡，属本任务点名要的大地图展示层，实现方式需服从原版渲染框架，不得推翻原框架）。
3. **裁剪超出需求的渲染层移植**：桌面版搬来的 entries 收集、自定义模块透传等，除大地图/小地图卡所需的最小部分外，按"每一行改动都能追溯到用户需求"的标准裁掉。
4. 修完 → `node build_regex.mjs MiniMapStatusMobile.html` → 用户重新导入真机验证（UUID `1fe27bc2-f26b-4946-a60e-5ad7c1a7766e` 不变，覆盖导入）。
5. 待用户澄清后处理：「大地图不是完整复制」的确切含义（可能指功能裁剪，勿自行猜测动手）。

## 3. 真机现象数据（保留，已按勘误重新标注）

聊天：还星余火，1 条 AI 楼（mesid=0）。`#maintext-container` 显示「加载中」且隐藏是 `status-only-mode` 的**设计行为**，不是 bug，勿误判。

| 探查 | 导入版本 | 页签 | 其它 |
|---|---|---|---|
| A | **手机原版**（未修改） | 8 个：🗺️小地图 / 🌏大地图 / 🧑 周云 / 💀 Ghost(同事) / 🐻 伯兰(同事) / 🐯 列夫(同事) / 🦌 瑟维(同事) / 🏟️据点 | 时间/地点/4 选项正常 |
| B | **新版**（本任务产物） | **只剩 1 个：周云** | 时间/地点/4 选项正常 |

注：探查 A 出现「小地图/大地图」页签是原版自己的渲染结果（原版 createAttributeItem 对地图数组字段本就渲染地图引擎），**不代表原版有模块化 entries 收集**——原版是把整份 rootData 的角色列表逐个建卡，地图字段在卡片属性里渲染。下个会话复现原版行为时以解包原版代码为准，不要凭本表推断。

## 4. IAB 真机调试要点（沿用）

- `agent.browsers.get("iab")` → 打开 `http://127.0.0.1:8000/` → 进入「还星余火」。IAB 标签会被宿主随机重置/重排，每批操作前重新 `browser.tabs.list()` 按 URL 匹配；用户自己开的标签可能接管不了（unavailable）。
- 错误捕获：注入 `window.onerror` + `console.error` 包装到 iframe 的 contentWindow，再手动 `window.reRenderStatusBar()`（新版已把该函数从闭包导出到 window；**原版没有此导出**）。
- IAB 截图管道不可用（guest capture failed）；视觉验证靠 computed style 断言或让用户看。
- file:// 被禁，本地服务：`npx http-server -p 8642 -s`。

## 5. 新版代码地图（MiniMapStatusMobile.html，grep 锚点）

| 模块 | 锚点字符串 | 说明 |
|---|---|---|
| 立绘引擎 IIFE | `动态立绘渲染引擎` | head 内，与桌面版同源；含 savePortraitChoice/collectPortraitVariants/openPortraitLightbox |
| 图片表 | `MMS_IMAGE_DATA_START` | 唯一标记块；别名 `window.PORTRAIT_MAP = window.MMS_IMAGE_DATA.portrait` 等；已并入手机版独有 4 条头像 |
| 图片管理 | `const MMS_IMG = {` | renderImageList/saveImageDataToSource（findSelfRegex 用手机版 UUID） |
| 名称工具 | `function mmsPlainName` | mmsStripEmoji/mmsNormalizeDisplayName；mmsNormalizeName 在 MMS 模块内另有一份 |
| MMS 模块 | `window.MMS = {` | 地图配置（$mms_roster 精简三键）/API 预设（$mms_api_presets+$mms_config 原位合并）/fetchModels/标签池+copyMapTags（只复制 pool）/大地图编排（loadMapArt/injectBigMapArt/generateMapArt 等）/boot |
| 大地图渲染器 | `MMS_MAPART_STYLES` | mmsRenderMapArt + `MMS_BIGMAP_ART_STATE` 全局开关 |
| 地图引擎 | `class TacticalMapEngine` | 加了第 4 参 options（customSVG 底图 / hereName 光环） |
| 大地图卡片 | `createBigMapArtItem(key, markersData, bma)` | 工具栏调 `window.MMS.*` |
| 渲染管线 | `renderAll()` | 被 hook：rootData 先过 `window.MMS.injectBigMapArt` |
| **页签收集** | `renderCharacterTabs(rootData)` | **回归 bug 主战场**（见 §2.2），需按原版逻辑重写 |
| 地图分支 | `createAttributeItem(key, value) {` | 大地图走 createBigMapArtItem；开关关闭回退普通列表 |
| 正文管线 | 第二个 `document.addEventListener('DOMContentLoaded'` | extract*/reRenderStatusBar 定义在此闭包内，已 `window.` 导出（导出发生在第二个 listener，时序上晚于第一个 listener 里的 MMS.boot 等，改代码时留意） |
| UI 初始化 | 第一个 `document.addEventListener('DOMContentLoaded'` | initSettingsPanel/initThemeToggle/MMS_IMG.initImageUI/MMS.boot/initApiPresetUI/initMapsUI |

## 6. 标准工作流

```
改 MiniMapStatusMobile.html
→ node build_tailwind.mjs MiniMapStatusMobile.html     （改了 class 才需要）
→ node build_inline_deps.mjs MiniMapStatusMobile.html  （新增 fa 图标才需要）
→ node build_regex.mjs MiniMapStatusMobile.html        （产物 ~463KB，压缩 -20%）
→ node _sim_mobile_harness.mjs                          （改断言模板后重新生成 harness）
→ git add + commit（备注短 hash）
```

- 语法自检：`new Function(每个内联脚本)`；围栏纪律：源文件 ``` 恰好 2 处。
- 构建断言：findRegex 含捕获组会构建失败（67b7842 引入的防回归，**保留勿删**——产物 JS 含 $1 字面量，酒馆会按捕获组展开注入正文 YAML）。
- harness 生成：`_sim_mobile_harness.mjs` 读模板 `integration-test/mobile-harness.template.html`（占位符 `/*__WIDGET_HTML_JSON__*/`）注入产物；内嵌 JSON 的 `</` 已转义防 script 截断。

## 7. git 历史

- `2c45cce`/`285e7be` 及更早：桌面版历史
- `9d6608b`：手机版主体移植（含本次回归 bug 的引入）
- `2904a6d`：标签池复制改为仅池内
- `67b7842`：findRegex 去捕获组（修复 $1 注入，保留）
- `a13b2c9`：前版交接文档（其探查 A 结论有误，本文已勘误）

## 8. 其它已知事项

- `$mms_roster` 手机版只读写 `maps/mapTags/bigmapArt` 三键并保留桌面版写入的其它键；`$mms_config` 原位合并不覆盖桌面版字段。
- 6 套皮肤全保留（已评估均为轻量纯 CSS，非性能瓶颈）。
- 性能优化已落地：Tailwind 构建期内联（16.1KB，替代 cdn.tailwindcss.com 每楼 ~110KB 运行时编译）、js-yaml/FA 子集内联、图片 lazy、`.map-layer` 提层。
