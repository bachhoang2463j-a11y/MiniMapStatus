// 「保存到源码」回写模拟：复刻页面运行时拼接逻辑，验证压缩产物语法安全性
const fs = require('fs');
const path = require('path');

const j = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'regex-美化状态栏[独立更新].json'), 'utf8')
);
let src = j.replaceString;

// ===== 完全复刻页面运行时逻辑（MiniMapStatus.html serializeImageData，含实体加固） =====
const MMS_IMG_BLOCK_RE = /\/\* ==== MMS_IMAGE_DATA_START[\s\S]*?MMS_IMAGE_DATA_END ==== \*\//;
const serializeImageData = (data) => {
  const json = JSON.stringify(data, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/&(?=(?:lt|gt|quot|amp|apos|#\d{1,5}|#x[0-9a-fA-F]{1,5});)/g, '\\u0026');
  const startMark = '/* ' + '==== MMS_IMAGE_DATA_START ==== */';
  const endMark = '/* ' + '==== MMS_IMAGE_DATA_END ==== */';
  return startMark + '\nwindow.MMS_IMAGE_DATA = ' + json + ';\n' + endMark;
};

// 从产物标记块解析当前数据（等价页面编辑态 imageData）
const blockMatch = src.match(MMS_IMG_BLOCK_RE);
// 块内是 terser 压缩后的 JS 字面量 `window.MMS_IMAGE_DATA={portrait:{...},...}`（键名无引号，非 JSON）
const jsonText = blockMatch[0].slice(
  blockMatch[0].indexOf('{'),
  blockMatch[0].lastIndexOf('}') + 1
);
const data = new Function('return ' + jsonText)();
console.log(
  '解析出图片数据: 立绘', Object.keys(data.portrait).length,
  '/ 底图', Object.keys(data.background).length,
  '/ 头像', Object.keys(data.avatar).length
);

const clone = (d) => JSON.parse(JSON.stringify(d));
const scenarios = [];

// 场景A：原样回写（数据未变）
scenarios.push(['A 原样回写', data]);

// 场景B：URL 含 &quot;（可通过 validateImageUrl——只禁 <> " 空格 $记号）
const dB = clone(data);
dB.portrait['测试角色'] = 'https://example.com/img?a=1&quot;b=2';
scenarios.push(['B URL含&quot;', dB]);

// 场景C：URL 含 &lt;/script&gt;
const dC = clone(data);
dC.portrait['测试角色2'] = 'https://example.com/x?lt=&lt;/script&gt;';
scenarios.push(['C URL含&lt;/script&gt;', dC]);

// 场景D：普通查询串 URL（a=1&b=2，非实体模式）
const dD = clone(data);
dD.portrait['测试角色3'] = 'https://example.com/img?a=1&b=2&c=3';
scenarios.push(['D 普通查询串URL', dD]);

// 场景E：名称含 $&（validateImageName 不校验 $ 记号，validateImageUrl 才查）
const dE = clone(data);
dE.portrait['费$&兰克'] = 'https://example.com/e.jpg';
scenarios.push(['E 名称含$&记号', dE]);

// 酒馆管线实体解码模拟（ecbfad6 修复时实测的行为：代码块内容 &xx; → 字符）
const NAMED = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&amp;': '&', '&apos;': "'" };
const ENTITY_RE = /&(?:lt|gt|quot|amp|apos|#\d{1,5}|#x[0-9a-fA-F]{1,5});/g;
const decodeEntities = (t) =>
  t.replace(ENTITY_RE, (s) => {
    if (NAMED[s]) return NAMED[s];
    const body = s.slice(2, -1);
    return String.fromCodePoint(parseInt(body, s[2] === 'x' || s[2] === 'X' ? 16 : 10));
  });

function check(name, text) {
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
  const openTags = (text.match(/<script/g) || []).length;
  const closeTags = (text.match(/<\/script/g) || []).length;
  const flag = bad === 0 && openTags === closeTags ? 'OK  ' : 'FAIL';
  console.log(
    '  [' + flag + '] ' + name +
    ' — 脚本块' + scripts.length + ' 语法错' + bad +
    ' 标签开' + openTags + '/闭' + closeTags +
    (openTags !== closeTags ? ' 【标签不匹配→脚本被截断】' : '')
  );
}

for (const [name, d] of scenarios) {
  const out = src.replace(MMS_IMG_BLOCK_RE, () => serializeImageData(d));
  console.log('== 场景' + name + ' ==');
  check('回写后直接语法   ', out);
  check('回写后过管线解码 ', decodeEntities(out));
  // 往返保真：回写块求值后，数据值必须与写入前完全一致（\u003c/\u0026 转义不改变值）
  const blk = out.match(MMS_IMG_BLOCK_RE)[0];
  const rt = new Function(
    'return ' + blk.slice(blk.indexOf('{'), blk.lastIndexOf('}') + 1)
  )();
  const diffs = [];
  for (const cat of Object.keys(d)) {
    for (const k of Object.keys(d[cat])) {
      if (rt[cat][k] !== d[cat][k]) diffs.push(cat + '「' + k + '」');
    }
  }
  console.log(
    diffs.length === 0
      ? '  [OK  ] 往返保真 — ' + Object.values(d).reduce((n, c) => n + Object.keys(c).length, 0) + ' 项值全部一致'
      : '  [FAIL] 往返失真: ' + diffs.join(', ')
  );
}

// 名称 $ 记号：复刻新版 validateImageName，断言 $& 名称现在被入口拦截
const validateImageName = (name) =>
  !name ? '不能为空'
  : /[<>"`]/.test(name) ? '不能包含 < > " ` 字符'
  : /[\r\n\t]/.test(name) ? '不能包含换行或制表符'
  : /\$(?:&|`|'|<|\d|\$)/.test(name) ? '包含 $&、$1 等 JS 替换特殊记号，会破坏页面注入'
  : '';
console.log('== 名称 $ 记号校验（新版 validateImageName 复刻） ==');
for (const n of ['费$&兰克', '角色$1', '$`测试', '正常角色', '向震虎(投篮)']) {
  const err = validateImageName(n);
  console.log('  ' + (err ? '[拦截] ' : '[放行] ') + JSON.stringify(n) + (err ? ' — ' + err : ''));
}
