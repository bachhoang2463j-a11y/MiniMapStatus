#!/usr/bin/env node
/**
 * test-public-release.mjs
 * 针对 MiniMapStatus-公开版.html 的自动化回归与安全门禁断言套件
 * 包含：
 *  1. 结构与围栏纪律断言（自围栏、内部零三反引号）
 *  2. 标记块唯一性断言（MMS_IMAGE_DATA 起止标记恰好 1 处）
 *  3. 全量内联脚本 new Function 语法校验
 *  4. MMS_IMAGE_DATA 角色图片白名单与旧角色黑名单校验（仅索恩+3新角色）
 *  5. MMS 纯逻辑与业务状态机回归（取自 integration-test/harness.html）
 *     - 现金计算与回血倍率
 *     - 每日结算与对账幂等
 *     - 独立小地图 miniArt 提示词三闸门与渲染器
 *     - 楼层变量 swipe 槽兜底与正文碎片守卫
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, 'MiniMapStatus-公开版.html');
const html = readFileSync(HTML_PATH, 'utf8');

console.log('====================================================');
console.log('  MiniMapStatus 公开版自动化回归与门禁断言套件');
console.log('====================================================\n');

let passCount = 0;
function pass(desc) {
  passCount++;
  console.log(`[PASS] ${desc}`);
}

// ---------------------------------------------------------
// 1. 结构与围栏纪律断言
// ---------------------------------------------------------
assert(/<\/html>/i.test(html), 'MiniMapStatus-公开版.html 必须以 </html> 闭合');
pass('HTML 结构闭合完整');

const strippedFences = html.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
assert(!strippedFences.includes('```'), '组件源码内部严禁裸三反引号（仅允许头尾自围栏）');
const fenceCount = (html.match(/```/g) || []).length;
assert.strictEqual(fenceCount, 2, `自围栏序列数必须恰好为 2（首行与末行），实际 ${fenceCount}`);
pass('围栏纪律通过（头尾自围栏合法，内部零裸三反引号）');

const startMatches = html.match(/\/\* ==== MMS_IMAGE_DATA_START ==== \*\//g) || [];
const endMatches = html.match(/\/\* ==== MMS_IMAGE_DATA_END ==== \*\//g) || [];
assert.strictEqual(startMatches.length, 1, `MMS_IMAGE_DATA_START 必须恰好 1 处，实际 ${startMatches.length}`);
assert.strictEqual(endMatches.length, 1, `MMS_IMAGE_DATA_END 必须恰好 1 处，实际 ${endMatches.length}`);
pass('MMS_IMAGE_DATA 起止标记块唯一且无歧义');

// ---------------------------------------------------------
// 2. 内联脚本语法检查
// ---------------------------------------------------------
const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const scriptBlocks = [];
let sm;
while ((sm = scriptRegex.exec(html))) {
  scriptBlocks.push(sm[1]);
}
assert(scriptBlocks.length >= 1, '必须至少包含 1 个内联脚本块');

scriptBlocks.forEach((code, idx) => {
  try {
    new Function(code);
  } catch (err) {
    assert.fail(`脚本块 #${idx + 1} 语法解析失败: ${err.message}`);
  }
});
pass(`全量内联脚本 (${scriptBlocks.length} 块) new Function 语法校验全部通过`);

// ---------------------------------------------------------
// 3. MMS_IMAGE_DATA 图片白名单断言
// ---------------------------------------------------------
const imgBlockMatch = html.match(/\/\* ==== MMS_IMAGE_DATA_START ==== \*\/([\s\S]*?)\/\* ==== MMS_IMAGE_DATA_END ==== \*\//);
assert(imgBlockMatch, '未找到 MMS_IMAGE_DATA 标记块');

const extractFn = new Function('window', imgBlockMatch[1] + '; return window.MMS_IMAGE_DATA;');
const winStub = {};
const extractedImageData = extractFn(winStub);

assert(extractedImageData, 'window.MMS_IMAGE_DATA 提取失败');
const { portrait, avatar, background } = extractedImageData;

assert(portrait && typeof portrait === 'object', 'portrait 必须为对象');
assert(avatar && typeof avatar === 'object', 'avatar 必须为对象');
assert(background && typeof background === 'object', 'background 必须为对象');

// 预期立绘
const EXPECTED_PORTRAITS = {
  '索恩': 'https://imgur.la/images/2026/09/02/_compressed.jpg',
  '冯·霍恩海姆': 'https://imgur.la/images/2026/09/26/hohenheim_portrait.png',
  '冯': 'https://imgur.la/images/2026/09/26/hohenheim_portrait.png',
  '威廉·退尔': 'https://imgur.la/images/2026/09/26/william_tell_portrait.png',
  '威廉': 'https://imgur.la/images/2026/09/26/william_tell_portrait.png',
  '伊斯坎达尔': 'https://imgur.la/images/2026/09/26/iskandar_portrait.png',
  '大帝': 'https://imgur.la/images/2026/09/26/iskandar_portrait.png',
  '征服王': 'https://imgur.la/images/2026/09/26/iskandar_portrait.png',
};

// 预期头像
const EXPECTED_AVATARS = {
  '索恩': 'https://cdn.jsdelivr.net/gh/bachhoang2463j-a11y/test1@main/头像/suoen_compressed.png',
  '朱利安·索恩': 'https://cdn.jsdelivr.net/gh/bachhoang2463j-a11y/test1@main/头像/suoen_compressed.png',
  '冯·霍恩海姆': 'https://imgur.la/images/2026/09/26/feng_avater.png',
  '冯': 'https://imgur.la/images/2026/09/26/feng_avater.png',
  '威廉·退尔': 'https://imgur.la/images/2026/09/26/weilan_avatar.png',
  '威廉': 'https://imgur.la/images/2026/09/26/weilan_avatar.png',
  '伊斯坎达尔': 'https://imgur.la/images/2026/09/26/dadi_avatar.png',
  '大帝': 'https://imgur.la/images/2026/09/26/dadi_avatar.png',
  '征服王': 'https://imgur.la/images/2026/09/26/dadi_avatar.png',
};

// 校验 portrait 键和值
assert.strictEqual(
  Object.keys(portrait).length,
  Object.keys(EXPECTED_PORTRAITS).length,
  `portrait 应严格包含 ${Object.keys(EXPECTED_PORTRAITS).length} 条映射，实际 ${Object.keys(portrait).length} 条`
);
for (const [k, url] of Object.entries(EXPECTED_PORTRAITS)) {
  assert.strictEqual(portrait[k], url, `portrait[${k}] URL 错误: ${portrait[k]} vs ${url}`);
}
pass(`portrait 严格匹配公开版 4 角色 8 条映射（索恩、冯、威廉、大帝及别名）`);

// 校验 avatar 键和值
assert.strictEqual(
  Object.keys(avatar).length,
  Object.keys(EXPECTED_AVATARS).length,
  `avatar 应严格包含 ${Object.keys(EXPECTED_AVATARS).length} 条映射，实际 ${Object.keys(avatar).length} 条`
);
for (const [k, url] of Object.entries(EXPECTED_AVATARS)) {
  assert.strictEqual(avatar[k], url, `avatar[${k}] URL 错误: ${avatar[k]} vs ${url}`);
}
pass(`avatar 严格匹配公开版 4 角色 9 条映射（索恩、朱利安·索恩、冯、威廉、大帝及别名）`);

// 历史角色黑名单（严禁残留）
const BLACKLIST = [
  '弗兰克', '埃利奥特', '爱德华', '玛德琳', '林有声', '弗朗索瓦丝',
  '烈阳剑尊', '李长风', '青木真人', '卢青鹤', '墨云生', '刘玺', '铁无山',
  '明河剑祖', '上官玉', '欧阳冶', '林沐雪', '司徒南', '李玄青', '玄机子',
  '云中子', '赵无极', '星瞳', '段木痕', '陈风', '古剑心', '韩枫',
  '方无恨', '红娘子', '百花仙子', '韩立', '金玉娘', '赤魁', '石大嘴',
  '莫贝贝', '祝无霜', '赵刚', '吕金元', '白羽生', '阮青', '瑟维', '伯兰',
  '老加', 'Ghost', '幽灵', '伊诺', '库恩', '列夫', '图鲁', '阿维', '向震虎',
  '阴茎射后', '阴茎疲软', '阴茎全勃'
];

for (const name of BLACKLIST) {
  assert(!portrait[name], `旧角色 [${name}] 残留在 portrait 中！`);
  assert(!avatar[name], `旧角色 [${name}] 残留在 avatar 中！`);
}
pass(`历史遗留角色（弗兰克、玛德琳、埃利奥特、修仙等 50+ 角色）零残留`);

// 棋盘已由用户删除断言
assert(!background['棋盘'], '底图【棋盘】应已被移除');
pass('底图【棋盘】已确认移除，其它场景底图保留');

// ---------------------------------------------------------
// 4. MMS 核心业务纯逻辑函数沙箱回归断言（全量 harness 覆盖）
// ---------------------------------------------------------
const mmsScript = scriptBlocks.find((b) => b.includes('MMS_COMBAT_RESULT_VAR'));
assert(mmsScript, '必须包含 MMS 主脚本块');

const docStub = {
  getElementById: () => null,
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

const sandbox = new Function(
  'jsyaml', 'window', 'document',
  mmsScript + '\n;return {' +
  ' mmsBuildNewdayResult, mmsParseAttrList, mmsIsCurMax, mmsApplyAttrCommands,' +
  ' mmsNormalizeName, mmsMatchOne, mmsCashCompute, mmsFindNameField, mmsAttrsToString,' +
  ' mmsApplyRosterToState, mmsMergeState, mmsBuildSystemPrompt, mmsRenderMapArt,' +
  ' mmsPickFloorVarSlot, mmsIsStoryFragmentBlock };'
);

const fns = sandbox(() => ({}), {}, docStub);
assert(typeof fns.mmsCashCompute === 'function', 'mmsCashCompute 必须为函数');
assert(typeof fns.mmsBuildNewdayResult === 'function', 'mmsBuildNewdayResult 必须为函数');

// ---------- 4.1 结算与回血逻辑 ----------
const stateBase = {
  状态栏: {
    角色列表: [
      { 名字: '李娟', 属性: '[❤️HP:19/28][💧MP:3/14][🛡️防:5]' },
      { 名字: '陈教授', 属性: '[❤️HP:22/25][魔力:6/9]' },
      { 名字: '老赵', 属性: '[❤️HP:25/25]' },
    ],
    据点: { 名称: '小队营地', 现金: '520美元', 物资: '[绷带x2][罐头x5]' },
  },
};
const roster = {
  characters: [
    { name: '李娟', attrs: [{ key: '❤️HP', value: '28/28' }, { key: '💧MP', value: '14/14' }] },
    { name: '陈教授', attrs: [{ key: '❤️HP', value: '25/25' }, { key: '魔力', value: '9/9' }] },
    { name: '老赵', attrs: [{ key: '❤️HP', value: '25/25' }] },
  ],
  modules: [],
};
const bill = {
  id: 'nd-99-abc',
  floorId: 99,
  date: '1925年1月17日',
  days: 1,
  cashBefore: 520,
  totalCost: 65,
  items: [
    { category: '住宿', cost: 12, details: '客房' },
    { category: '餐饮', cost: 15, details: '晚餐' },
    { category: '弹药', cost: 38, details: '弹药' },
  ],
};

const r1 = fns.mmsBuildNewdayResult(stateBase, bill, roster);
assert.strictEqual(r1.state['状态栏']['据点']['现金'], '455美元', '现金扣减准确');
assert(r1.state['状态栏']['角色列表'][0]['属性'].includes('[❤️HP:25/28]'), '李娟 HP 回复');
assert(r1.state['状态栏']['角色列表'][0]['属性'].includes('[💧MP:6/14]'), '李娟 MP 回复');
assert(r1.state['状态栏']['角色列表'][0]['属性'].includes('[🛡️防:5]'), '非数值属性不被回血改动');
assert(r1.state['状态栏']['角色列表'][1]['属性'].includes('[❤️HP:25/25]'), '陈教授 HP 夹取到上限');
assert(r1.state['状态栏']['角色列表'][1]['属性'].includes('[魔力:8/9]'), '陈教授 魔力回复');
assert(!r1.report.healed.find((x) => x.name === '老赵'), '老赵满血不生成命令');
assert.strictEqual(r1.report.healed.length, 2, 'healed 人数准确');
pass('每日结算回血与扣费逻辑断言通过');

// 回血倍率封顶
const b10 = Object.assign({}, bill, { days: 10 });
const r10 = fns.mmsBuildNewdayResult(stateBase, b10, roster);
assert(r10.state['状态栏']['角色列表'][0]['属性'].includes('[❤️HP:28/28]'), '回血封顶上限夹取');
pass('回血倍率封顶逻辑断言通过');

// 名字标准化与前缀匹配
assert.strictEqual(fns.mmsNormalizeName('🔮 冯·霍恩海姆 (队长)'), '冯霍恩海姆队长', 'mmsNormalizeName 归一');
assert(fns.mmsMatchOne('威廉', ['威廉·退尔', '索恩']), '别名模糊匹配');
pass('名册名字标准化与前缀匹配断言通过');

// ---------- 4.2 独立小地图 miniArt 断言 ----------
const mkRoster = (miniEnabled) => ({
  characters: [], modules: [],
  maps: { minimap: true, bigmap: false },
  mapTags: { pool: [], mini: ['客厅', '卧室'], big: [] },
  bigmapArt: { enabled: false, note: '', style: 'flat' },
  miniArt: { enabled: miniEnabled, note: '', style: 'flat' },
});

const pMiniOn = fns.mmsBuildSystemPrompt(mkRoster(true));
assert(!pMiniOn.includes('小地图'), 'miniArt 开启时系统提示词中无小地图章节');
const pMiniOff = fns.mmsBuildSystemPrompt(mkRoster(false));
assert(pMiniOff.includes('🗺️ 小地图'), 'miniArt 关闭时系统提示词保留小地图章节');
pass('独立小地图 miniArt 系统提示词闸门断言通过');

const miniJson = {
  name: '总督套房', ground: 'wood',
  terrain: [{ type: 'carpet', shape: 'rect', at: [330, 380], size: [340, 260] }],
  outline: { shape: 'roundRect', at: [90, 110], size: [820, 780], r: 24 },
  gates: [[500, 880]],
  roads: [],
  features: [
    { type: 'wall', at: [430, 110], size: [16, 240] },
    { type: 'bed', at: [150, 190], size: [80, 110], rot: 90 },
    { type: 'lantern', at: [500, 300] },
  ],
  houses: [], trees: [],
  labels: [{ at: [500, 950], text: '客栈大堂' }],
  markers: [{ emoji: '🛏️', name: '床铺', x: 20, y: 26, desc: '可以休息' }],
};
const svg = fns.mmsRenderMapArt(miniJson, 'flat', 'mini');
assert(svg.includes('url(#mms-mini-wood)'), '近景木地板材质 pattern 生效');
assert(svg.includes('url(#mms-mini-carpet)'), '近景地毯材质 pattern 生效');
assert(!svg.includes('>N<'), 'mini 不画大地图罗盘');
pass('近景材质渲染器 mini 分支断言通过');

// ---------- 4.3 楼层变量 swipe 槽兜底与碎片守卫 ----------
const pick = fns.mmsPickFloorVarSlot;
const frag = fns.mmsIsStoryFragmentBlock;
assert(typeof pick === 'function', 'mmsPickFloorVarSlot 必须存在');
assert(typeof frag === 'function', 'mmsIsStoryFragmentBlock 必须存在');

const bag = { stat_data: { 状态栏: { 地点: '📍 悉尼' } }, $mms_meta: { hash: 'h', ts: 111, mesId: 46 } };
assert.strictEqual(pick([bag, undefined]), bag, '槽兜底：选非空槽');
assert(frag({ 行动选项: { 名字: '团队行动', 选项: ['1. 行动'] } }) === true, '只有行动选项的块判定为正文碎片');
assert(frag({ 状态栏: { 日期和时间: '⏰ 1925年' } }) === false, '含实质模块不误判为碎片');
pass('楼层变量 swipe 槽兜底与正文碎片守卫断言通过');

// ---------------------------------------------------------
// 5. 构建产物 regex-美化状态栏[公开版].json 专项断言
// ---------------------------------------------------------
const JSON_OUT_PATH = join(__dirname, 'regex-美化状态栏[公开版].json');
const jsonContent = readFileSync(JSON_OUT_PATH, 'utf8');
const scriptObj = JSON.parse(jsonContent);

assert.strictEqual(scriptObj.id, '2b8a7c13-e4d5-4a7f-9b1a-8e2c3d4f5a6b', '公开版独立 UUID 匹配');
assert.strictEqual(scriptObj.scriptName, '美化状态栏[公开版]', '公开版脚本名匹配');
assert.deepStrictEqual(scriptObj.placement, [2], '仅 AI 输出生效 (placement: [2])');
assert.strictEqual(scriptObj.markdownOnly, true, 'markdownOnly 为 true');
assert.strictEqual(scriptObj.disabled, false, '默认启用 (disabled: false)');
pass('公开版正则 JSON 元数据配置（独立UUID、名称、生效范围）断言通过');

// 酒馆管线实体解码
const NAMED = { lt: '<', gt: '>', quot: '"', amp: '&', apos: "'", not: '¬', copy: '©', reg: '®', times: '×' };
const ENTITY_RE = /&(#[0-9]{1,5};|#x[0-9a-fA-F]{1,5};|amp;|lt;|gt;|quot;|apos;|not;|copy;|reg;|times;|amp|lt|gt|quot|not|copy|reg|times)/g;
const decodePipeline = (t) =>
  t.replace(ENTITY_RE, (m) => {
    const body = m.slice(1);
    if (body[0] === '#') {
      return body[1] === 'x' || body[1] === 'X'
        ? String.fromCodePoint(parseInt(body.slice(2, -1), 16))
        : String.fromCodePoint(parseInt(body.slice(1, -1), 10));
    }
    return NAMED[body.replace(/;$/, '')];
  });

const decodedReplaceString = decodePipeline(scriptObj.replaceString);
const outScripts = [...decodedReplaceString.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
assert(outScripts.length >= 1, '产物解码后必须包含内联脚本');
outScripts.forEach((code, i) => {
  try {
    new Function(code);
  } catch (err) {
    assert.fail(`产物解码后内联脚本 #${i} 语法解析失败: ${err.message}`);
  }
});
pass(`产物解码后全量脚本 (${outScripts.length} 块) 语法校验全部通过（& 实体免疫生效）`);

// 提取产物内的 MMS_IMAGE_DATA
const outImgBlock = decodedReplaceString.match(/\/\* ==== MMS_IMAGE_DATA_START[\s\S]*?MMS_IMAGE_DATA_END ==== \*\//);
assert(outImgBlock, '产物解码后 MMS_IMAGE_DATA 标记块完整存在');
const outData = new Function('return ' + outImgBlock[0].slice(outImgBlock[0].indexOf('{'), outImgBlock[0].lastIndexOf('}') + 1))();
assert.strictEqual(Object.keys(outData.portrait).length, 8, '产物立绘严格 8 条映射');
assert.strictEqual(Object.keys(outData.avatar).length, 9, '产物头像严格 9 条映射');
for (const name of BLACKLIST) {
  assert(!outData.portrait[name], `旧角色 [${name}] 残留在产物 portrait 中！`);
  assert(!outData.avatar[name], `旧角色 [${name}] 残留在产物 avatar 中！`);
}
pass('产物内 MMS_IMAGE_DATA 索恩+公开版三角色数据保真，旧角色零残留');

console.log(`\n====================================================`);
console.log(`  全部断言通过！共 ${passCount} 项测试 100% 成功`);
console.log(`====================================================\n`);
