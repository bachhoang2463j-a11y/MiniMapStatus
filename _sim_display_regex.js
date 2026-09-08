// displayRegex 行为验证：酒馆正则是全局替换（replace 的 g 语义），逐场景断言
const MARKER = '【状态栏标记点】';
// findRegex 去掉 JS 字面量斜杠后即酒馆侧使用的形态；酒馆按 /g 全局替换
const RE_SRC =
  '(?:' + MARKER + '(?![\\s\\S]*' + MARKER + ')|' +
  '<Status_block>(?![\\s\\S]*?<Status_block>)[\\s\\S]*?</Status_block>)';
const re = new RegExp(RE_SRC, 'gi');
const reG = new RegExp(RE_SRC, 'g'); // 等价酒馆行为

const W = '<WIDGET>';
const cases = [
  // 用户实际样例：Combat_block + 真标记 + 音乐 QR 触发词
  ['用户样例',
    '名字: "食尸鬼*2"\n    - 角色:\n        名字: "犹格索托斯之子"\n</Combat_block>\n\n' + MARKER + '\n\n[点一首歌:stone]',
    (out) => out.includes(W) && out.includes('[点一首歌:stone]') && out.includes('</Combat_block>')],
  // 前置泄漏（7ee9f36 修的问题不得回退）：只换最后一个标记，前置泄漏被跳过
  ['前置泄漏正文保留',
    MARKER + '……（泄漏在正文前）\n正文内容\n\n' + MARKER,
    (out) => !out.includes('正文内容') === false && (out.match(new RegExp(MARKER, 'g')) || []).length === 1],
  // 旧格式双块：最后一个块被替换（酒馆逐次应用，负向断言保证不取旧块），
  // 旧块保留是既有行为（数据由 stat_data 变量承载，旧块只是历史渲染残留）
  ['旧双块',
    '正文A\n<Status_block>状态1</Status_block>\n中间\n<Status_block>状态2</Status_block>\n尾',
    (out) => out.includes('正文A') && out.includes('中间') && out.includes('尾') &&
      (out.match(/<Status_block>/g) || []).length === 1 && out.includes(W)],
  // 旧格式单块 + 触发词尾巴
  ['旧单块带触发词',
    '正文\n<Status_block>状态</Status_block>\n[点一首歌:stone]',
    (out) => out.includes('正文') && out.includes('[点一首歌:stone]') && !out.includes('Status')],
  // 正常单标记：精准替换标记本身
  ['正常单标记',
    '正文正文\n\n' + MARKER,
    (out) => out === '正文正文\n\n' + W],
];

let allPass = true;
for (const [name, text, verify] of cases) {
  const out = text.replace(reG, W);
  const pass = verify(out);
  allPass = allPass && pass;
  console.log((pass ? '[OK] ' : '[FAIL] ') + name + ' → ' + JSON.stringify(out.length > 120 ? out.slice(0, 120) + '…' : out));
}
console.log(allPass ? '全部场景通过' : '存在失败场景');
process.exit(allPass ? 0 : 1);
