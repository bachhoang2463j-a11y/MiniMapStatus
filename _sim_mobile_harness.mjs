// _sim_mobile_harness.mjs — 生成 integration-test/mobile-harness.html
// 读取 MiniMapStatusMobile.html，与断言模板拼成自包含测试页（无需 file:// fetch，可直接在 IAB 打开）
// 用法：node _sim_mobile_harness.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const widget = readFileSync('D:/Project/MiniMapStatus/MiniMapStatusMobile.html', 'utf8');
// 剥首尾围栏（与 build_regex 同规则）
const html = widget.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
if (!/<\/html>/i.test(html)) throw new Error('MiniMapStatusMobile.html 内容异常');

const template = readFileSync('D:/Project/MiniMapStatus/integration-test/mobile-harness.template.html', 'utf8');
// </ 转义为 <\/（JSON 合法转义）：防内嵌字符串里的 </script> 提前终止 harness 脚本块
const payload = JSON.stringify(html).replace(/<\//g, '<\\/');
const out = template.replace('/*__WIDGET_HTML_JSON__*/', () => payload);
if (out === template) throw new Error('占位符未找到');
writeFileSync('D:/Project/MiniMapStatus/integration-test/mobile-harness.html', out, 'utf8');
console.log('已生成 integration-test/mobile-harness.html（内嵌', html.length, '字符）');
