// _sim_mobile_harness.mjs — 生成 integration-test/mobile-harness.html、mobile-llm-harness.html 与 mobile-baseline.html
// mobile-harness：新功能断言（mock「角色列表」键）；mobile-llm-harness：LLM 地图版断言（双地图 AI 生成）；
// mobile-baseline：原版基线回归断言（mock 真机「用户列表」键楼层，双 iframe 对比备份原版）
// 用法：node _sim_mobile_harness.mjs
import { readFileSync, writeFileSync } from 'node:fs';

function stripFences(text) {
  return text.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
}

// </ 转义为 <\/（JSON 合法转义）：防内嵌字符串里的 </script> 提前终止 harness 脚本块
function inject(templatePath, placeholder, html, outPath) {
  const template = readFileSync(templatePath, 'utf8');
  const payload = JSON.stringify(html).replace(/<\//g, '<\\/');
  const out = template.replace(placeholder, () => payload);
  if (out === template) throw new Error('占位符未找到: ' + placeholder);
  writeFileSync(outPath, out, 'utf8');
  console.log('已生成', outPath, '（内嵌', html.length, '字符）');
}

// —— 新功能 harness（内嵌新版 MiniMapStatusMobile.html）——
const widget = readFileSync('D:/Project/MiniMapStatus/MiniMapStatusMobile.html', 'utf8');
const widgetHtml = stripFences(widget);
if (!/<\/html>/i.test(widgetHtml)) throw new Error('MiniMapStatusMobile.html 内容异常');
inject(
  'D:/Project/MiniMapStatus/integration-test/mobile-harness.template.html',
  '/*__WIDGET_HTML_JSON__*/',
  widgetHtml,
  'D:/Project/MiniMapStatus/integration-test/mobile-harness.html',
);

// —— LLM 地图版 harness（内嵌 MiniMapStatusMobileLLM.html：双地图 AI 生成回归）——
const widgetLLM = readFileSync('D:/Project/MiniMapStatus/MiniMapStatusMobileLLM.html', 'utf8');
const widgetLLMHtml = stripFences(widgetLLM);
if (!/<\/html>/i.test(widgetLLMHtml)) throw new Error('MiniMapStatusMobileLLM.html 内容异常');
inject(
  'D:/Project/MiniMapStatus/integration-test/mobile-llm-harness.template.html',
  '/*__WIDGET_HTML_JSON__*/',
  widgetLLMHtml,
  'D:/Project/MiniMapStatus/integration-test/mobile-llm-harness.html',
);

// —— 原版基线 harness（备份 8/26 原版 + 新版，同 mock 楼层对比）——
const backup = JSON.parse(
  readFileSync('D:/Project/MiniMapStatus/备份/regex-美化状态栏[手机专用].json', 'utf8'),
);
const originalHtml = stripFences(String(backup.replaceString));
if (!/<\/html>/i.test(originalHtml)) throw new Error('备份原版 JSON 内容异常');
const baselineTemplate = readFileSync(
  'D:/Project/MiniMapStatus/integration-test/mobile-baseline.template.html',
  'utf8',
);
const baseline = baselineTemplate
  .replace('/*__ORIGINAL_HTML_JSON__*/', () => JSON.stringify(originalHtml).replace(/<\//g, '<\\/'))
  .replace('/*__WIDGET_HTML_JSON__*/', () => JSON.stringify(widgetHtml).replace(/<\//g, '<\\/'));
if (baseline === baselineTemplate) throw new Error('基线模板占位符未找到');
writeFileSync('D:/Project/MiniMapStatus/integration-test/mobile-baseline.html', baseline, 'utf8');
console.log('已生成 integration-test/mobile-baseline.html（原版', originalHtml.length, '字符 + 新版', widgetHtml.length, '字符）');
