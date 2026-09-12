#!/usr/bin/env node
/**
 * build_inline_deps.mjs — 把 js-yaml 与 font-awesome 从 CDN 外链改为源 HTML 内联
 *
 * 目的：消灭每个楼层 iframe 的外链依赖（jsdelivr 波动/首次往返），完全离线可用。
 *   - js-yaml@4.1.0：整包 min 版内联（全部功能都在用）
 *   - font-awesome@4.7.0：按源文件实际使用的图标做字体子集（pyftsubset）+
 *     只保留用到的 CSS 规则，字体以 base64 data-URI 内嵌（42 图标约 8KB，全量需 134KB）
 *
 * 用法：
 *   node build_inline_deps.mjs [源文件名]   （默认 MiniMapStatus.html，手机版传 MiniMapStatusMobile.html）
 *
 * 何时重跑：源文件新增了 fa 图标/类之后（build_regex.mjs 的 FA_SUBSET 断言会拦截报错）。
 * 依赖：node ≥18（内置 fetch）+ python（fonttools[woff]）+ 网络（下载下方 pinned 版本）。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_NAME = process.argv[2] || 'MiniMapStatus.html';
const SRC = join(__dirname, SRC_NAME);
const TMP = join(__dirname, '_inline_tmp');

const JSYAML_URL = 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.min.js';
const FA_CSS_URL = 'https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css';
const FA_FONT_URL = 'https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/fonts/fontawesome-webfont.woff2';
const JSYAML_TAG = `<script src="${JSYAML_URL}"></script>`;
const FA_TAG = `<link href="${FA_CSS_URL}" rel="stylesheet" />`;

// 与源 HTML 中 INLINE-DEP 标记块配套（块内内容由本脚本整体重写，勿手改）
const JSYAML_BLOCK_RE = /<script>\s*\/\* ==== INLINE-DEP js-yaml START[\s\S]*?INLINE-DEP js-yaml END ==== \*\/\s*<\/script>/;
const FA_BLOCK_RE = /<style>\s*\/\* ==== INLINE-DEP font-awesome START[\s\S]*?INLINE-DEP font-awesome END ==== \*\/\s*<\/style>/;

function fail(msg) {
  console.error(`[build_inline_deps] 错误: ${msg}`);
  process.exit(1);
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) fail(`下载失败 ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

/** 解析扁平（含 @keyframes 嵌套花括号）minified CSS 为 [selector, block] 列表 */
function parseCssRules(css) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const selector = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    rules.push([selector, css.slice(open, j)]);
    i = j;
  }
  return rules;
}

async function main() {
  let html = readFileSync(SRC, 'utf8');
  mkdirSync(TMP, { recursive: true });

  // ---------- 1. js-yaml 内联 ----------
  const jsyamlJs = (await download(JSYAML_URL, join(TMP, 'js-yaml.min.js'))).toString('utf8').trim();
  if (jsyamlJs.includes('`') || jsyamlJs.includes('</script')) fail('js-yaml 内容含反引号或 </script，违反围栏纪律');
  const jsyamlBlock =
    '<script>\n' +
    '/* ==== INLINE-DEP js-yaml START（build_inline_deps.mjs 生成，勿手改） ==== */\n' +
    jsyamlJs + '\n' +
    '/* ==== INLINE-DEP js-yaml END ==== */\n' +
    '</script>';
  if (html.includes(JSYAML_TAG)) html = html.replace(JSYAML_TAG, jsyamlBlock);
  else if (JSYAML_BLOCK_RE.test(html)) html = html.replace(JSYAML_BLOCK_RE, jsyamlBlock);
  else fail(`未找到 js-yaml 的 CDN 标签或既有内联块，请检查 ${SRC_NAME}`);

  // ---------- 2. font-awesome 子集内联 ----------
  const faCss = (await download(FA_CSS_URL, join(TMP, 'font-awesome.min.css'))).toString('utf8').trim();
  if (faCss.includes('`')) fail('fa css 含反引号，违反围栏纪律');
  await download(FA_FONT_URL, join(TMP, 'fontawesome-webfont.woff2'));

  // 源文件用到的全部 fa- 类（含动态拼接的，如三元表达式里的 fa-chevron-up）；
  // 提取前先剔除既有的内联依赖块，防止上次内联进来的别名类名污染 token 集
  const scanHtml = html
    .replace(JSYAML_BLOCK_RE, '')
    .replace(FA_BLOCK_RE, '');
  const tokens = [...new Set(scanHtml.match(/fa-[a-z0-9-]+/g) || [])];
  if (!tokens.length) fail('源文件未找到任何 fa- 类');

  const rules = parseCssRules(faCss);
  // 图标码点表：注意 FA 4.7 有别名组合选择器（如 .fa-gear:before,.fa-cog:before{content:"\f013"}），
  // 需按逗号拆分逐段匹配，否则别名组里的图标会被漏进子集（渲染成空框）
  const codepointOf = {}; // fa-xxx -> 'f02d'
  for (const [sel, block] of rules) {
    const cm = block.match(/content:"\\([0-9a-f]+)"/);
    if (!cm) continue;
    for (const part of sel.split(',')) {
      const m = part.trim().match(/^\.((?:fa-[a-z0-9-]+)):(?:before|after)$/);
      if (m) codepointOf[m[1]] = cm[1];
    }
  }
  const icons = tokens.filter((t) => codepointOf[t]); // 有字形码点的
  const modifiers = tokens.filter((t) => !codepointOf[t]); // fa-spin 等行为类
  const unknown = modifiers.filter((t) => !rules.some(([s]) => s.includes('.' + t)));
  if (unknown.length) fail(`源文件用到但 font-awesome 4.7 不存在的类: ${unknown.join(', ')}`);

  // 字体子集（pyftsubset）
  const unicodes = icons.map((t) => 'U+' + codepointOf[t]).join(',');
  execFileSync(
    'python',
    ['-m', 'fontTools.subset', join(TMP, 'fontawesome-webfont.woff2'),
      `--output-file=${join(TMP, 'subset.woff2')}`, '--flavor=woff2', `--unicodes=${unicodes}`],
    { stdio: 'pipe' }
  );
  const fontB64 = readFileSync(join(TMP, 'subset.woff2')).toString('base64');

  // 保留用到的 CSS 规则：.fa 基类 / 已用类 / 已用 keyframes；@font-face 换成内嵌版
  const used = new Set(tokens);
  const kept = [];
  for (const [sel, block] of rules) {
    if (sel.startsWith('@font-face')) continue;
    if (sel.startsWith('@')) {
      // at 规则（keyframes 等）：取规则名（如 @-webkit-keyframes fa-spin 的 fa-spin），命中已用类才保留
      const name = (sel.match(/([\w-]+)\s*$/) || [])[1];
      if (name && used.has(name)) kept.push(sel + block);
      continue;
    }
    const isIconRule = /:(?:before|after)/.test(sel);
    const classes = sel.match(/\.fa-[a-z0-9-]+|\.fa(?![\w-])/g) || [];
    // 图标规则（:before 别名组）：任一类名已用即保留（别名选择器无害）；
    // 其余规则（.fa 基类/行为类）：全部类名都必须已用
    const ok = classes.length > 0 && (isIconRule
      ? classes.some((c) => c !== '.fa' && used.has(c.slice(1)))
      : classes.every((c) => c === '.fa' || used.has(c.slice(1))));
    if (ok) kept.push(sel + block);
  }
  if (!kept.some((r) => r.startsWith('.fa{'))) fail('未能保留 .fa 基类规则');
  if (icons.some((t) => !kept.some((r) => r.includes('.' + t + ':before')))) fail('图标 :before 规则保留不全');

  const faBlock =
    '<style>\n' +
    `/* ==== INLINE-DEP font-awesome START（build_inline_deps.mjs 生成的 ${icons.length} 图标子集，新增图标后重跑） ==== */\n` +
    `/* FA_SUBSET_CODEPOINTS: ${icons.map((t) => codepointOf[t]).join(',')} */\n` +
    `@font-face{font-family:'FontAwesome';src:url(data:font/woff2;base64,${fontB64}) format('woff2');font-weight:normal;font-style:normal}\n` +
    kept.join('') + '\n' +
    '/* ==== INLINE-DEP font-awesome END ==== */\n' +
    '</style>';
  if (html.includes(FA_TAG)) html = html.replace(FA_TAG, faBlock);
  else if (FA_BLOCK_RE.test(html)) html = html.replace(FA_BLOCK_RE, faBlock);
  else fail(`未找到 font-awesome 的 CDN link 或既有内联块，请检查 ${SRC_NAME}`);

  // ---------- 3. 校验与写出 ----------
  if (html.includes(JSYAML_URL) || html.includes(FA_CSS_URL)) fail('内联后仍残留 CDN 引用');
  if ((html.match(/```/g) || []).length !== 2) fail('围栏纪律：源文件 ``` 数量应为 2（首尾自围栏）');
  writeFileSync(SRC, html);

  const kb = (n) => (n / 1024).toFixed(1) + 'KB';
  console.log(`[build_inline_deps] js-yaml 内联: ${kb(jsyamlJs.length)}`);
  console.log(`[build_inline_deps] font-awesome 子集: ${icons.length} 图标 + ${modifiers.length} 行为类(${modifiers.join(',')}); 字体 ${kb(fontB64.length)} base64; CSS 规则 ${kept.length} 条`);
  console.log(`[build_inline_deps] ${SRC_NAME} 现大小: ${kb(Buffer.byteLength(html, 'utf8'))}`);
}

main().catch((e) => fail(e && e.message ? e.message : e));
