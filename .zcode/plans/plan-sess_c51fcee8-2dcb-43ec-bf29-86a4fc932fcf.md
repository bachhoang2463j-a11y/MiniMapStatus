# NewDay 每日结算直连（昨天账单 → 状态栏，全程不经 LLM）

## 先回答你纠结的两个问题

**手操按钮 vs 自动注入**：仿照已有的战斗结算直连做**自动注入 + 台账幂等**，刷新时多次渲染不会重复扣款/回血。这正是 `$mms_combat_sync` 已经解决的问题——同一份账单有唯一 `id`，台账 `{lastId, appliedFloor, ...}` 记下已应用的账单，任何实例（含刷新后重新渲染的）在写入前比对 `lastId === billId`，相等即跳过。此外还有"单写者"防线：`checkLastAssistantFloor` 保证只有最新 AI 楼的状态栏实例会落盘（MiniMapStatus.html:13158）。按钮方案只保留一个**轻量"手动结算"入口**作为兜底（事件丢失/出错对账），不作为主流程。

**作弊问题**：扣款数字来自 LLM 输出的账单，脚本只是"搬运 + 计算"，无法防 LLM 编造金额——但注意新方案反而比现在**更抗篡改**：现状是 LLM 直接在状态栏里写 `cash_after`（AI 说多少是多少）；新方案后 LLM 只写"昨天花了什么"，余额 = 状态栏真值 − 总扣款，AI 无法单方面把余额改飞。护栏：总额与逐条 cost 之和对不上 >$1 时放弃本次自动结算，提示手操。

## 架构：三件套照抄 combat-sync 模式

```
NewDay.html(每楼渲染)                          MiniMapStatus.html(最新AI楼实例)
┌ parseRawContent() 解析账单(已有418-442行) ┐    ┌ pendingNewdayBill(): 读 $newday_bill_result,
│ 处理为载荷:                                │    │ 比对 $mms_newday_sync.lastId 判幂等
│  {id, floorId, date, cashBefore,           │    │ applyNewdayBill():
│   totalCost, items[...]}                   │    │   1. 现金: mmsApplyCashCommand(已10199-10256行,
└──> insertOrAssignVariables(                ───> │      模块['现金'] 绝对值命令, 30%波动仅告警)
        $newday_bill_result, {type:'chat'}) 事件 │   2. 回血: 每个名册固定角色 cur+20%max 向上取整,
                                            事件 │      夹 [0,max], 复用 MMS_COMBAT_ATTR_ALIASES.hp/mp
                                            触发 │   3. appendHistory 快照 + writeState 落盘
                                            触发 │   4. saveNewdaySync 台账落账(含锁定字段)
                                                └ 5. 指示器/事件/按钮回执
```

幂等防线（与 combat-sync 完全同构，共四道）：载荷唯一 id（楼层+日期哈希）→ 台账 lastId 比对 → 单写者 `checkLastAssistantFloor` → boot 对账兜底（重启/刷新后首次 boot 重查 pending，已应用则跳过）。

## 具体改动

### A. NewDay.html（约 +60 行）
1. **数据源变更**：`parseRawContent()` 只依赖 `team_cash_before` + `total_cost`；`team_cash_after` 仅展示不再作真值（缺失/自相矛盾时显示"待脚本核算"）。
2. **生成结算按钮**（账单区底部，vintage 风格，含隐藏状态：已结算/已失效）。
3. **点击流程**：读取待结算消息变量（脚本写入）→ 写入 `$newday_bill_result` 载荷（chat 变量，含 id/date/cashBefore/totalCost/items）→ `eventEmit` 通知 → 收到"已应用"回执后按钮翻成"✓ 已结算"。
4. **自动触发**：仅在最新 AI 楼实例（`getLastMessageId` 判定）自动结算，历史楼层只渲染只读视图；已应用消息变量则直接显示已结算态。

### B. MiniMapStatus.html（约 +180 行）
1. **常量区**（~9258 行处）：`$newday_bill_result` / `$mms_newday_sync` / 事件名。
2. **构建函数**（~10339 行处，combat 构建旁）：`mmsBuildNewdayResult(state, bill, roster)` → `{state, report}`——
   - 现金：定位状态栏第一个含 `['现金']` 的固定模块，`mmsApplyCashCommand` 写入 `[团队现金:绝对值]`；
   - 回血：遍历 `角色列表` 与 roster `mmsMatchOne` 严格匹配，对每个已有 cur/max 型 HP/MP 键生成 `[键:ceil(cur+0.2*max)]` 命令（伤势键不动——醒来未必满血，伤势由后续 AI 更新）；
   - `report` 含 `{cashBefore, cashApplied, healed:[名], unmatched:[名]}`。
3. **引擎方法**（~11758 行 combat 方法旁）：`loadNewdayBill / loadNewdaySync / saveNewdaySync / pendingNewdayBill / applyNewdayBill`——写入前快照（剧情回溯可回滚）、写后 `eventEmit`+BroadcastChannel 回执。
4. **触发点**（~16410 行 boot 对账区）：`eventOn` NewDay 结算事件 + 对账兜底；复用 `mms:combat-applied` 同款通知通道。
5. **设置开关**（~3844 行）：「每日结算直连（NewDay 账单自动扣款 + 角色回血 20%）」复选框，默认开。
6. **幂等写入时序**：先 `saveNewdaySync`（锁住）再 `writeState`（消息变量替换，同楼原子），防半写状态卡死。

## 不做的事（防蔓延）
- 不改名册 UI、不动 RpgCombat、不动合并层战斗硬锁（回血不需要：每天只发生一次，与战斗叙事无冲突场景）。
- 不改 LLM 提示词模板结构（仍输出 team_cash_before/total_cost；**建议**后续把提示词里 `team_cash_after` 字段删掉/改可选，减少 LLM 算错空间——这是你酒馆预设侧的改动，不在本仓库）。
- 不为假想错误（货币格式异常、负余额）写专门处理：金额解析沿用 `parseFloat` 清洗链，负余额显示出来让用户肉眼发现。

## 验证流程（sillytavern-plugin-dev 单 HTML 项目）
1. `node --check` 两个 HTML 内嵌脚本（提取后校验）。
2. IAB mock 数据测试：mock `getVariables` 返回带账单载荷/状态栏 stat_data 的环境，验证——首次结算写入正确、二次渲染/模拟刷新不重复扣款、历史楼层不触发、回血向上取整 + cur/max 夹取、30% 波动告警不误伤。
3. 报告完成，等你导入酒馆实测（含真 Chrome 排障一遍事件触发链）。
4. （可选）按 harness-regression 规范搭 `newday.test.mjs` 断言脚手架——仓库目前只有 `build_regex.mjs`，无既有测试设施，默认搭一个最小 node 断言脚本随仓库留存。