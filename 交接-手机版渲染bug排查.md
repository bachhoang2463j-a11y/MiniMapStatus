# 交接文档：手机轻量版（MiniMapStatusMobile）真机渲染 bug 排查

> 写给下一个会话。前序会话已完成「手机专用版功能移植」并两次修复，当前遗留一个真机渲染不完整的 bug。
> 项目根目录：`D:\Project\MiniMapStatus`。请先通读本文再动手；遵守全局 AGENTS.md（中文回复、手术式修改、git 提交备注短 hash）。

---

## 1. 任务背景（已完成部分，勿重做）

用户要把桌面版 `MiniMapStatus.html`（931KB）的四大能力移植到早期手机轻量版（`regex-美化状态栏[手机专用].json`，8/26 基座），**保持正文直读的数据轻量性**：

- 已交付：独立大地图（AI 绘制底图 generateRaw + `$mms_map_art` 聊天变量缓存）、地图管理（开关渲染层控制 + 标签池三栏 + 复制按钮）、图片管理（完整移植含保存到源码）、性能优化（Tailwind 构建期内联替代 CDN 运行时编译、js-yaml/FA 子集内联）。
- **明确不移植**：stat_data 楼层变量读取、状态独立更新引擎、injectPrompts、同楼共存标记点、行动选项即时生效——手机版维持「正则截取最后一个 `<Status_block>` → js-yaml → StoryRenderer」的正文直读路径。
- 设置面板为最新版仪表盘样式但只留 4 个 tab：界面与交互 / 独立LLM更新（仅 API 配置，供大地图绘图）/ 地图管理 / 图片管理。
- 卡片立绘按**无框渐变羽化**重写（区别于桌面版带框 pc-portrait-box），正文立绘引擎与桌面版同源不动。
- 6 套皮肤全保留（已评估均为轻量纯 CSS，非性能瓶颈）。
- 新增源文件 `MiniMapStatusMobile.html`；产物仍叫 `regex-美化状态栏[手机专用].json`（UUID `1fe27bc2-f26b-4946-a60e-5ad7c1a7766e` 不变，覆盖导入）。

git 历史：`9d6608b`（主体移植）→ `2904a6d`（标签池复制改为仅池内）→ `67b7842`（捕获组修复，见下）。

## 2. 已修复的第一个真机 bug（重要背景，勿重复排查）

**现象**：导入新版后 widget iframe 存在、静态 HTML 渲染，但主脚本（30 万字符）整体不执行，全部显示「加载中」。

**根因**：产物 JS 里含字面量 `$&`、`$1`（校验提示文案 `"包含 $&、$1 等 JS 替换特殊记号…"`，自桌面版移植）。旧手机版 findRegex 带捕获组 `([\s\S]*?)`，酒馆套用替换时 `$1` 被展开为捕获的 Status_block 内 YAML，直接注入主脚本 → `Invalid or unexpected token`。桌面版因 findRegex 全非捕获组而幸免。

**修复**（`67b7842`）：findRegex 捕获组改裸惰性匹配；`build_regex.mjs` 加防回归断言（findRegex 含捕获组即构建失败）。

**注意**：酒馆管线**不展开 `$&`**（真机实证），只按捕获组展开 `$1-$9`。产物含 `$` 字面量本身不是问题，前提是 findRegex 无捕获组。

## 3. 当前待排查 bug（本交接核心）

### 3.1 用户报告

「是匹配上了，但是怎么全被替换成选项了？」——即楼层里状态栏区域看起来只剩行动选项，角色卡片/地图等内容大量缺失。

### 3.2 真机实测数据（前会话 IAB 探查，聊天：还星余火，仅 1 条 AI 楼，mesid=0）

**探查 A**（导入 `67b7842` 修复版后首查）：
- widget 渲染正常面：`timeDisplay`=`⏰ 3088年 · 8月7日 · 09:35`、`locationDisplay`=📍维兰城遗址…、`#options-list` 4 项、`yaml-data-source` 3066 字符
- 页签 8 个：`🗺️小地图 / 🌏大地图 / 🧑 周云 / 💀 Ghost(同事) / 🐻 伯兰(同事) / 🐯 列夫(同事) / 🦌 瑟维(同事) / 🏟️据点`
- `body.className` = `romantic-mode status-only-mode`

**探查 B**（稍后再次探查，中间用户可能重导入/刷新过）：
- **页签只剩 1 个：`周云`**——小地图/大地图/据点/其余角色卡片全部消失
- 其余指标与 A 相同（options 仍 4 项、时间地点正常）

**非 bug 项（勿误判）**：
- `#maintext-container` 显示「加载中」且 display:none、高度 0——这是 `status-only-mode`（美化状态栏模式）的**设计行为**，正文本来就被隐藏。用户若要正文用设置里「一体式美化」。
- 行动选项显示是正常的（Status_block 里的行动选项模块）。

### 3.3 已有假设（按优先级）

**H1（最可疑）：renderCharacterTabs 二次重渲时中途抛错或 entries 缩水。**
新改写的 `renderCharacterTabs`（见 §4 锚点）先清空 `characterTabs`/`charactersContainer`，再按 entries 逐个建卡。若对某个条目 `createCharacterCard` 抛异常，页签就停在部分状态；而 `renderActionOptions` 在 renderAll 中排在它之后——**探查 B 里 options 仍有 4 项，很可能是上一次成功渲染的残留**（第二次渲染在 options 清空前就抛了）。这能同时解释「8 页签 → 1 页签」和「看起来只剩选项」。
排查入口：在 iframe 里 hook `window.onerror` + `console.error` 后手动调 `window.reRenderStatusBar()`，看抛什么。

**H2：真机 YAML 键名与假设不符。**
我的新 entries 收集只显式认 `rootData['小地图']`/`rootData['大地图']`/`rootData['角色列表']`/`rootData['人物']`，**角色列表的旧版关键词探测（`用户|角色|列表|user|role|list` → `用户列表`）只在 `entries.length === 0` 时兜底**。若真机 YAML 用「用户列表」键且「小地图/大地图」模块存在，entries 非空 → 兜底不触发 → 角色全丢。（但探查 A 出现过完整 8 页签，与此矛盾——所以要么两次渲染间 YAML/键名变了，要么 H1 才是主因。**第一步先 dump yaml-data-source 的实际键名**。）

**H3：两次渲染竞态/数据差异。**
`renderPageFromMessage` 末尾 `setTimeout(() => reRenderStatusBar(), 100)` 会二次渲染；两次渲染理应同数据，但 MMS.injectBigMapArt 在 renderAll 里包了深拷贝+合成的显示副本（renderAll 的 rootData 被 hook 替换，见 §4），若 bigmapArt 开启且 `$mms_map_art` 存在/不存在两种状态下行为不同，可对比。

### 3.4 建议排查步骤（可直接照做）

1. **IAB attach**：`agent.browsers.get("iab")` → 新标签打开 `http://127.0.0.1:8000/` → 进入「还星余火」聊天。IAB 标签会被宿主随机重置/重排，**每批操作前重新 `browser.tabs.list()` 并按 URL 匹配**；`about:blank` 的用户标签接管不了（`unavailable`）。
2. **hook 错误**（一次性 evaluate 注入到主页面，再穿透到 iframe）：
   ```js
   const f = document.querySelector('#chat iframe');
   const win = f.contentWindow;
   win.__errs = [];
   win.addEventListener('error', e => win.__errs.push(String(e.message) + ' @' + e.filename + ':' + e.lineno));
   const oe = win.console.error;
   win.console.error = (...a) => { win.__errs.push(a.map(String).join(' ')); oe.apply(win.console, a); };
   ```
3. **dump 数据源键名**：`win.jsyaml.load(f.contentDocument.getElementById('yaml-data-source').textContent)` → `Object.keys()`。确认是「角色列表」还是「用户列表」（→ 验证 H2）。
4. **手动重渲复现**：`win.reRenderStatusBar()`（已在 `67b7842` 前的移植中暴露到 window）→ 读 `win.__errs` + 数 `.character-tab-btn`（→ 验证 H1）。
5. 若 H1 实锤，沿调用链单步：`renderAll` → `injectBigMapArt`（MMS 模块）→ `renderCharacterTabs` → `createCharacterCard`（含立绘数据源/变体收集/`mmsPlainName`）→ `createAttributeItem`（地图分支读 `window.MMS.loadRoster()`）。
6. 修复后**必须重建产物并让用户重新导入**：`node build_regex.mjs MiniMapStatusMobile.html`。

### 3.5 harness 与真机的差异（为什么 harness 全过仍有真机 bug）

`integration-test/mobile-harness.html`（42/42 通过）的 mock YAML 用的是 **`角色列表`** 键；真机聊天 YAML 用的键名未实证（疑似 `用户列表`，见 H2）。harness 断言覆盖不到「模块存在 + 角色列表用别名键」的组合。修完后建议给 harness 补一条「用户列表键 + 小地图模块共存」用例（改 template 里 mockMessage 后 `node _sim_mobile_harness.mjs` 重新生成）。

---

## 4. 新版代码地图（MiniMapStatusMobile.html，约 8600 行，用 grep 锚点定位）

| 模块 | 锚点字符串 | 说明 |
|---|---|---|
| 立绘引擎 IIFE | `动态立绘渲染引擎` | head 内，与桌面版同源（buildPortraitHTML 无框渐变/mask）；含 savePortraitChoice/collectPortraitVariants/openPortraitLightbox |
| 图片表 | `MMS_IMAGE_DATA_START` | 唯一标记块；别名 `window.PORTRAIT_MAP = window.MMS_IMAGE_DATA.portrait` 等 |
| 图片管理 | `const MMS_IMG = {` | renderImageList/saveImageDataToSource（findSelfRegex 用手机版 UUID）等 |
| 名称工具 | `function mmsPlainName` | mmsStripEmoji/mmsNormalizeDisplayName；**mmsNormalizeName 在 MMS 模块内另有一份** |
| **MMS 模块** | `window.MMS = {` | 地图配置读写（$mms_roster 精简三键）/API 预设（$mms_api_presets+$mms_config）/fetchModels/标签池三栏+copyMapTags/大地图编排（loadMapArt/injectBigMapArt/generateMapArt/sanitizeMapArt 等）/boot |
| 大地图渲染器 | `MMS_MAPART_STYLES` | mmsRenderMapArt + `MMS_BIGMAP_ART_STATE` 全局开关 |
| 地图引擎 | `class TacticalMapEngine` | 已加第 4 参 options（customSVG 底图 / hereName 金色光环） |
| 大地图卡片 | `createBigMapArtItem(key, markersData, bma)` | 在 StoryRenderer 原型区，工具栏按钮调 `window.MMS.*` |
| 渲染管线 | `renderAll()` | **被 hook**：rootData 先过 `window.MMS.injectBigMapArt(rootData)` 再渲染 |
| 页签收集 | `renderCharacterTabs(rootData)` | **本次 bug 主战场**：显式认 小地图/大地图/角色列表/人物 四键 + 自定义对象模块透传 + legacy 兜底（仅 entries 空时） |
| 地图分支 | `createAttributeItem(key, value) {` | 数组拦截层：大地图走 createBigMapArtItem；开关关闭回退普通列表 |
| 正文管线 | 第二个 `document.addEventListener('DOMContentLoaded'` | extractLastBlock/extractMaintext/reRenderStatusBar 定义在**此闭包内**，已 `window.` 导出（注意：导出发生在第二个 listener，第一个 listener 里的 `MMS.boot()` 若在启动期就触发重渲会拿到 undefined——目前仅事件回调使用，时序安全，但改代码时留意） |
| UI 初始化 | 第一个 `document.addEventListener('DOMContentLoaded'` | initSettingsPanel/initThemeToggle/MMS_IMG.initImageUI/`MMS.boot()`/`MMS.initApiPresetUI()`/`MMS.initMapsUI()` |

构建脚本：`build_tailwind.mjs` / `build_inline_deps.mjs` / `build_regex.mjs` 均已参数化，手机版传 `MiniMapStatusMobile.html`；`build_regex.mjs` 手机版分支产出单 JSON（无标记清理脚本）+ 捕获组断言。

## 5. 标准工作流

```
改 MiniMapStatusMobile.html
→ node build_tailwind.mjs MiniMapStatusMobile.html     （改了 class 才需要）
→ node build_inline_deps.mjs MiniMapStatusMobile.html  （新增 fa 图标才需要）
→ node build_regex.mjs MiniMapStatusMobile.html        （产物 ~463KB，压缩 -20%）
→ node _sim_mobile_harness.mjs                          （重新生成 harness，IAB 跑断言）
→ git add + commit（备注短 hash）
```

- 语法自检：`new Function(每个内联脚本)`；围栏纪律：源文件 ``` 恰好 2 处（首尾自围栏）。
- 本地起服务给 IAB 用：`npx http-server -p 8642 -s`（IAB 禁 file://）。
- 真机验证需用户重新导入 json 覆盖（UUID 固定）。

## 6. 遗留开放问题（用户表述待澄清）

用户原话：「另外，大地图不是完整复制。标签池复制就是只复制当前标签池里有的」。后半句已落实（copyMapTags 只复制 pool）；**前半句「大地图不是完整复制」含义未确认**——可能指：a) 复制按钮语义（已改）；b) 大地图功能相对桌面版有裁剪（确实裁了：无「发给更新 AI 的标签白名单注入」机制，因手机版无更新 AI；标签池在手机版的作用主要是复制枚举+组织）。下个会话应先与用户确认这一点再动代码。

## 7. 其它已知事项

- `$mms_roster` 手机版只读写 `maps/mapTags/bigmapArt` 三键并保留桌面版写入的其它键，两版共用聊天不互踩；`$mms_map_art`/`$mms_api_presets`/`$mms_config` 与桌面版同名同语义（$mms_config 原位合并，不覆盖桌面版的提示词等字段）。
- 手机版独有头像 4 条（江魁锋/赵伟国/邱成钢/赵震涛）已并入 MMS_IMAGE_DATA.avatar。
- IAB 截图管道不可用（guest capture failed）；视觉验证靠 computed style 断言或让用户看。
- harness：`integration-test/mobile-harness.template.html` 是模板（占位符 `/*__WIDGET_HTML_JSON__*/`），`_sim_mobile_harness.mjs` 注入产物生成 `mobile-harness.html`；内嵌 JSON 里 `</` 已转义防 script 截断。
