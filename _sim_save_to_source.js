// 「保存到源码」回写模拟 v2 —— 适配 1feb5fa「全量 & 实体免疫」构建
//
// 构建层（build_regex.mjs 步骤5）把产物内所有 & 改写 &amp;，酒馆管线单遍解码逐字节
// 还原。产物的存储形态因此本身不是合法 JS（设计使然）——语法断言一律在「管线解码后」
// 的文本上执行。解码建模含无分号旧式命名实体（RpgCombat 实测：&&notify 的 &not → ¬）。
//
// 对比三版运行时序列化（「保存到源码」写入标记块的内容）：
//   committed  当前已提交：仅带分号核心实体（lt/gt/quot/amp/apos/数字）lookahead → \u0026
//   proposed   提议修正：全量 & → \u0026（对齐构建层「任何 & 都可能被解码」的威胁模型）
//   ampStyle   否决方案：全量 & → &amp;（本地「复制配置」粘贴回 HTML 再构建会双重转义）

const fs = require('fs');
const path = require('path');

const j = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'regex-美化状态栏[独立更新].json'), 'utf8')
);
const stored = j.replaceString;

// ---------- 酒馆管线解码建模（单遍，与 String.replace 语义一致，不重扫输出） ----------
// 有分号命名/数字实体 + 无分号旧式命名实体（HTML5 legacy 集，文本上下文逢匹配即解码）
const NAMED = { lt: '<', gt: '>', quot: '"', amp: '&', apos: "'", not: '¬', copy: '©', reg: '®', times: '×' };
const ENTITY_RE =
  /&(#[0-9]{1,5};|#x[0-9a-fA-F]{1,5};|amp;|lt;|gt;|quot;|apos;|not;|copy;|reg;|times;|amp|lt|gt|quot|not|copy|reg|times)/g;
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

// ---------- 运行时逻辑复刻（与 MiniMapStatus.html serializeImageData 同构） ----------
const MMS_IMG_BLOCK_RE = /\/\* ==== MMS_IMAGE_DATA_START[\s\S]*?MMS_IMAGE_DATA_END ==== \*\//;
const makeSerializer = (ampRe, ampTo) => (data) => {
  const json = JSON.stringify(data, null, 2).replace(/</g, '\\u003c').replace(ampRe, ampTo);
  const startMark = '/* ' + '==== MMS_IMAGE_DATA_START ==== */';
  const endMark = '/* ' + '==== MMS_IMAGE_DATA_END ==== */';
  return startMark + '\nwindow.MMS_IMAGE_DATA = ' + json + ';\n' + endMark;
};
const committed = makeSerializer(/&(?=(?:lt|gt|quot|amp|apos|#\d{1,5}|#x[0-9a-fA-F]{1,5});)/g, '\\u0026');
const proposed = makeSerializer(/&/g, '\\u0026');
const ampStyle = makeSerializer(/&/g, '&amp;');

// ---------- 断言工具 ----------
function checkScripts(label, text) {
  const scripts = [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  let bad = 0;
  scripts.forEach((code, i) => {
    try {
      new Function(code);
    } catch (e) {
      bad++;
      console.log('    脚本块 #' + i + ' 语法炸: ' + e.message.slice(0, 90));
    }
  });
  const open = (text.match(/<script/g) || []).length;
  const close = (text.match(/<\/script/g) || []).length;
  const ok = bad === 0 && open === close;
  console.log(
    '  [' + (ok ? 'OK  ' : 'FAIL') + '] ' + label +
    ' — 脚本块' + scripts.length + ' 语法错' + bad +
    ' 标签开' + open + '/闭' + close +
    (open !== close ? ' 【脚本被截断】' : '')
  );
  return ok;
}

function evalBlockValue(text) {
  const blk = text.match(MMS_IMG_BLOCK_RE)[0];
  return new Function('return ' + blk.slice(blk.indexOf('{'), blk.lastIndexOf('}') + 1))();
}

// ---------- 基线自检：新构建机制 + 解码建模自洽 ----------
console.log('== 基线：新产物存储形态与解码自洽性 ==');
console.log('  存储形态 &amp; 数量:', (stored.match(/&amp;/g) || []).length, '；非 &amp; 形式的 &:', (stored.match(/&(?!amp;)/g) || []).length);
const decodedBase = decodePipeline(stored);
const baseOk = checkScripts('产物解码后', decodedBase);
if (!baseOk) { console.log('  解码建模或产物异常，终止'); process.exit(1); }
const blockBase = decodedBase.match(MMS_IMG_BLOCK_RE)[0];
const data = evalBlockValue(decodedBase);
console.log(
  '  [OK  ] 基线数据: 立绘', Object.keys(data.portrait).length,
  '/ 底图', Object.keys(data.background).length,
  '/ 头像', Object.keys(data.avatar).length
);

// ---------- 场景矩阵 ----------
const URLS = {
  '带分号核心实体 &quot;': 'https://e.com/i?a=1&quot;b=2',
  '无分号旧式 &quot': 'https://e.com/i?a=1&quotb=2',
  '表外命名实体 &not;': 'https://e.com/i?a=1&not;c=2',
  '无分号前缀 &notify': 'https://e.com/i?a=1&notify=2',
  '普通查询串 &b=2': 'https://e.com/i?a=1&b=2&c=3',
};

function runScenario(serializerName, serializer, url) {
  const d = JSON.parse(JSON.stringify(data));
  if (url) d.portrait['测试'] = url;
  // 与页面运行时一致：对「存储形态」做标记块替换，再过管线解码 = iframe 实际收到
  const live = decodePipeline(stored.replace(MMS_IMG_BLOCK_RE, () => serializer(d)));
  const ok = checkScripts(serializerName + ' 解码后语法', live);
  try {
    const val = evalBlockValue(live);
    const exact = JSON.stringify(val) === JSON.stringify(d);
    console.log(
      exact ? '  [OK  ] 值往返保真' : '  [FAIL] 值失真 — 测试项实际值: ' + JSON.stringify(val.portrait['测试'])
    );
  } catch (e) {
    console.log('  [FAIL] 值解析失败: ' + e.message.slice(0, 70));
  }
  return ok;
}

for (const [label, url] of Object.entries(URLS)) {
  console.log('== committed（当前已提交） × ' + label + ' ==');
  runScenario('committed', committed, url);
}
for (const [label, url] of Object.entries(URLS)) {
  console.log('== proposed（提议：全量 \\u0026） × ' + label + ' ==');
  runScenario('proposed', proposed, url);
}

// ---------- ampStyle 否决依据：本地「复制配置」→ 粘贴回 HTML → 重新构建 的双重转义 ----------
console.log('== ampStyle（& → &amp;）双重转义演示 ==');
const urlG = 'https://e.com/i?a=1&quotb=2';
const dG = JSON.parse(JSON.stringify(data));
dG.portrait['测试'] = urlG;
const blockLocal = ampStyle(dG); // 「复制配置」产出 → 用户粘贴回本地 MiniMapStatus.html
// 直发路径（保存到源码）：管线单遍解码 &amp; → &，值正确
const liveG = decodePipeline(stored.replace(MMS_IMG_BLOCK_RE, () => blockLocal));
console.log('  直发路径（保存到源码）: ' + (evalBlockValue(liveG).portrait['测试'] === urlG ? '[OK] 保真' : '[FAIL]'));
// 本地重建路径：build_regex.mjs 步骤5 对全产物（含粘贴块）再做 & → &amp; → 双重转义
const rebuilt = blockLocal.replace(/&/g, '&amp;');
const liveR = decodePipeline(rebuilt);
const valR = evalBlockValue(liveR);
console.log('  本地重建路径: 原 ' + JSON.stringify(urlG) + ' → 实际 ' + JSON.stringify(valR.portrait['测试']) +
  (valR.portrait['测试'] === urlG ? ' [OK]' : ' [FAIL] 双重转义损坏'));
// 对照：proposed 的 \u0026 无 & 字符，构建全量转义不触碰
const blockP = proposed(dG);
const rebuiltP = decodePipeline(blockP.replace(/&/g, '&amp;'));
console.log('  proposed 对照: ' + (evalBlockValue(rebuiltP).portrait['测试'] === urlG ? '[OK] 重建后仍保真' : '[FAIL]'));

// ---------- 名称 $ 记号校验（与 178beb3 一致，回归确认） ----------
const validateImageName = (name) =>
  !name ? '不能为空'
  : /[<>"`]/.test(name) ? '不能包含 < > " ` 字符'
  : /[\r\n\t]/.test(name) ? '不能包含换行或制表符'
  : /\$(?:&|`|'|<|\d|\$)/.test(name) ? '包含 $&、$1 等 JS 替换特殊记号，会破坏页面注入'
  : '';
console.log('== 名称 $ 记号校验回归 ==');
for (const n of ['费$&兰克', '角色$1', '正常角色']) {
  const err = validateImageName(n);
  console.log('  ' + (err ? '[拦截] ' : '[放行] ') + JSON.stringify(n));
}
