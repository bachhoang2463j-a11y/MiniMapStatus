#!/usr/bin/env node
/**
 * build_regex.mjs — 从 MiniMapStatus.html 自动生成 SillyTavern 正则脚本 JSON
 *
 * 用法：
 *   node build_regex.mjs [源文件名]
 *     （默认 MiniMapStatus.html → 生成独立更新版双 JSON；
 *       传 MiniMapStatusMobile.html → 仅生成 regex-美化状态栏[手机专用].json，
 *       沿用手机版原 UUID 与 findRegex，覆盖更新同 id 脚本）
 *
 * 产物（每次运行重新生成，保持与 HTML 源码同步）：
 *   1. regex-美化状态栏[独立更新].json
 *      显示用正则（仅格式显示）：把楼层中的「【状态栏标记点】」或旧式
 *      <Status_block>…</Status_block>（取最后一个，连同其后所有内容）替换为
 *      小部件 HTML 代码块，由酒馆助手渲染为 iframe。
 *   2. regex-状态栏标记清理[上下文].json
 *      提示词用正则（仅格式提示词）：从发给 AI 的上下文中剥离标记点，节省 token。
 *   3. regex-美化状态栏[手机专用].json（源为 MiniMapStatusMobile.html 时）
 *      手机轻量版显示正则：仅替换最后一个 <Status_block> 块，数据从正文直读。
 *
 * 嵌入前会压缩产物（源码保持可读）：内联脚本过 terser、HTML/CSS 过
 * html-minifier-terser；MMS_IMAGE_DATA 标记块与「保存到源码」机制在产物上保留。
 * 依赖 npx（首次运行下载 terser@5 / html-minifier-terser@7 到 npm 缓存）。
 * 另含 FA 子集断言：新用了未内嵌的 fa 图标会构建失败（先跑 build_inline_deps.mjs）。
 *
 * 导入方式：SillyTavern → 扩展 → 正则（Regex）→ 导入脚本。
 * 两个脚本使用固定 UUID，重新构建导入时会覆盖更新同 id 脚本（若产生重复条目，
 * 删除旧条目即可）。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 目标源文件：默认桌面版；传 MiniMapStatusMobile.html 走手机轻量版分支
const SRC_NAME = process.argv[2] || 'MiniMapStatus.html';
const IS_MOBILE = SRC_NAME === 'MiniMapStatusMobile.html';
const SRC = join(__dirname, SRC_NAME);
const OUT_DISPLAY = IS_MOBILE
  ? join(__dirname, 'regex-美化状态栏[手机专用].json')
  : join(__dirname, 'regex-美化状态栏[独立更新].json');
const OUT_STRIP = join(__dirname, 'regex-状态栏标记清理[上下文].json');
const TMP = join(__dirname, '_minify_tmp');

// 固定 id：重复导入时保持同一身份，避免多副本
const DISPLAY_ID = IS_MOBILE
  ? '1fe27bc2-f26b-4946-a60e-5ad7c1a7766e' // 手机版原 UUID，覆盖更新既有导入
  : '43f2c434-708b-467e-b9fd-dac04dc1d80e';
const STRIP_ID = '3288eda7-da4d-4021-9b85-02f6f1026b42';

const MARKER = '【状态栏标记点】';

// 与 build_inline_deps.mjs 的内联标记块配套（token 提取需剔除，防别名类名污染）
const JSYAML_BLOCK_RE = /<script>\s*\/\* ==== INLINE-DEP js-yaml START[\s\S]*?INLINE-DEP js-yaml END ==== \*\/\s*<\/script>/;
const FA_BLOCK_RE = /<style>\s*\/\* ==== INLINE-DEP font-awesome START[\s\S]*?INLINE-DEP font-awesome END ==== \*\/\s*<\/style>/;

function fail(msg) {
  throw new Error('[build_regex] ' + msg);
}

// FA 子集断言：源文件新用了未内嵌的 fa 图标时构建失败（字形缺失会渲染成空框）
function checkFaSubset(html) {
  const faBlock = (html.match(FA_BLOCK_RE) || [])[0] || '';
  if (!faBlock) fail('未找到内联 font-awesome 块，请先运行 node build_inline_deps.mjs');
  const manifest = new Set(((faBlock.match(/FA_SUBSET_CODEPOINTS: ([0-9a-f,]+)/) || [])[1] || '').split(','));
  const stripped = html.replace(JSYAML_BLOCK_RE, '').replace(FA_BLOCK_RE, '');
  const tokens = [...new Set(stripped.match(/fa-[a-z0-9-]+/g) || [])];
  const missing = [];
  for (const t of tokens) {
    const m = faBlock.match(new RegExp('\\.' + t + ':(?:before|after)[^}]*\\{content:"\\\\([0-9a-f]+)"'));
    if (m) {
      if (!manifest.has(m[1])) missing.push(t + '（字形未进子集字体）');
    } else if (!faBlock.includes('.' + t)) {
      missing.push(t + '（无 CSS 规则）');
    }
  }
  if (missing.length) {
    fail('以下 fa 类未内嵌: ' + missing.join(', ') + '\n请运行 node build_inline_deps.mjs 重新生成内联依赖后重试。');
  }
}

/**
 * 产物压缩：源码保持可读，仅在嵌入正则 JSON 前压缩。
 *  1) 每个内联 <script> 过 terser —— --comments 保留 MMS_IMAGE_DATA 标记注释
 *     （「保存到源码」功能在产物上做标记块正则替换，标记必须在）；
 *     evaluate=false 防止 serializeImageData 里特意拆分的标记字符串被常量折叠
 *     合并成第二处可匹配文本。顶层名不 mangle（无 toplevel）。
 *  2) html-minifier-terser 压 HTML 空白/注释与 CSS（minify-js 关闭——脚本已单独
 *     压过且需保留 --comments 行为）。
 */
function buildMinifiedHtml(html) {
  mkdirSync(TMP, { recursive: true });
  try {
    // 1) 抽出有内容的内联 <script>（跳过外链与空的 yaml 数据源标签），占位待回填
    const slots = [];
    let out = html.replace(
      /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi,
      (m, code) => {
        if (!code.trim()) return m;
        slots.push(code);
        return `<!--__MINIFY_SLOT_${slots.length - 1}__-->`;
      }
    );

    // 2) 逐块 terser（保留 MMS_IMAGE_DATA 标记注释与 @license 声明，禁用常量折叠）
    for (let i = 0; i < slots.length; i++) {
      const inFile = join(TMP, 'in-' + i + '.js');
      const outFile = join(TMP, 'out-' + i + '.js');
      writeFileSync(inFile, slots[i]);
      execSync(
        `npx -y terser@5 "${inFile}" --compress evaluate=false --mangle --comments "/MMS_IMAGE_DATA|@license/" -o "${outFile}"`,
        { cwd: __dirname, stdio: 'pipe' }
      );
      const min = readFileSync(outFile, 'utf8');
      new Function(min); // 语法级断言
      if (min.includes('</scr' + 'ipt')) fail(`脚本块 #${i} 压缩产物含 </script，会截断内联脚本`);
      if (min.includes('```')) fail(`脚本块 #${i} 压缩产物含裸三反引号，违反围栏纪律`);
      out = out.replace(`<!--__MINIFY_SLOT_${i}__-->`, () => '<script>' + min.trim() + '</script>');
    }

    // 3) HTML 空白/注释 + CSS 压缩（不碰脚本内容）
    const inHtml = join(TMP, 'in.html');
    writeFileSync(inHtml, out);
    const minified = execSync(
      `npx -y html-minifier-terser@7 "${inHtml}" --collapse-whitespace --remove-comments --minify-css`,
      { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }
    ).toString('utf8');

    // 4) 产物断言：标记块唯一、结构完整、无围栏风险
    if (!/<\/html>/i.test(minified)) fail('压缩产物缺少 </html>');
    if (minified.includes('```')) fail('压缩产物含裸三反引号，违反围栏纪律');
    const blocks = minified.match(/\/\* ==== MMS_IMAGE_DATA_START[\s\S]*?MMS_IMAGE_DATA_END ==== \*\//g) || [];
    if (blocks.length !== 1) fail(`产物中 MMS_IMAGE_DATA 标记块应恰好 1 处，实际 ${blocks.length} 处（「保存到源码」会失败）`);
    if ((minified.match(/\/\* ==== MMS_IMAGE_DATA_START/g) || []).length !== 1) {
      fail('产物中 MMS_IMAGE_DATA_START 标记注释出现多次（疑似 serializeImageData 常量折叠）');
    }
    // 拼接点安全：「保存到源码」整体替换 START→END 区间并以 ; 结尾。若 terser 把
    // 语句合并的逗号落在 END 标记之后（区间外），拼接后会产出 ";," 语法错误
    if (/\/\* ==== MMS_IMAGE_DATA_END ==== \*\/\s*,/.test(minified)) {
      fail('MMS_IMAGE_DATA_END 标记后紧跟逗号（terser 逗号表达式合并落在标记区间外）——「保存到源码」拼接后会产生 ;, 语法错误');
    }

    // 5) 全量 & 实体免疫：酒馆管线对代码块内容做 HTML 实体解码，且包含无分号旧式
    //    实体（RpgCombat 实测：压缩后 &&notify 的 &not → ¬ 炸语法；此前 &quot;→"""
    //    同族事故）。代码位置的 & 无法用 JS 转义规避，统一把产物内所有 & 改写为
    //    &amp;：管线单遍解码后逐字符还原（代码/字符串/HTML 文本/属性/CSS 皆然），
    //    解码结果与改写前逐字节一致（下方断言），从根上免疫任何实体解码行为。
    const immune = minified.replace(/&/g, '&amp;');
    if (/&(?!amp;)/.test(immune)) fail('全量 & 转义后仍存在非 &amp; 形式的 & 序列');
    if (immune.replace(/&amp;/g, '&') !== minified) fail('&amp; 还原一致性校验失败');
    return immune;
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

function buildWidgetReplacement() {
  let html = readFileSync(SRC, 'utf8');
  // 剥离源文件首尾可能残留的 markdown 围栏，避免破坏外层代码块
  html = html.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
  if (!/<\/html>/i.test(html)) {
    throw new Error(`${SRC_NAME} 内容异常：未找到 </html>`);
  }
  checkFaSubset(html);
  const minified = buildMinifiedHtml(html);
  console.log(`[build_regex] 产物压缩: ${html.length} -> ${minified.length} 字符（-${Math.round((1 - minified.length / html.length) * 100)}%）`);
  return '```\n' + minified + '\n```';
}

function makeRegexScript({ id, scriptName, findRegex, replaceString, markdownOnly, promptOnly }) {
  return {
    id,
    scriptName,
    findRegex,
    replaceString,
    trimStrings: [],
    placement: [2], // 仅 AI 输出
    disabled: false,
    markdownOnly,
    promptOnly,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

// 显示正则——桌面版：精准替换最后一个【状态栏标记点】或最后一个 <Status_block> 块本身。
// 标记之后的文本（如音乐 QR 触发词）不吞，格式控制交给用户侧流程。
// 同楼共存（正文AI 追加行动选项 Status_block）时：标记点分支让位（负向先行），
// 由 Status_block 分支把紧邻前方的标记点连同空白一并吞掉——中间隔正文则只替换
// Status_block 本身（不吞正文，标记点残留属可接受的罕见场景）。
//
// 显示正则——手机版：沿用手机版原始正则，仅替换最后一个 <Status_block> 块本身
// （手机轻量版数据从正文直读，无标记点/独立更新机制）。
const displayRegex = IS_MOBILE
  ? '/<Status_block>(?![\\s\\S]*?<Status_block>)\\s*([\\s\\S]*?)\\s*<\\/Status_block>/i'
  : `/(?:${MARKER}(?![\\s\\S]*${MARKER})(?![\\s\\S]*<Status_block>)|(?:${MARKER}\\s*)?<Status_block>(?![\\s\\S]*?<Status_block>)[\\s\\S]*?<\\/Status_block>)/i`;

const displayScript = makeRegexScript({
  id: DISPLAY_ID,
  scriptName: IS_MOBILE ? '美化状态栏[手机专用]' : '美化状态栏[独立更新]',
  findRegex: displayRegex,
  replaceString: buildWidgetReplacement(),
  markdownOnly: true,
  promptOnly: false,
});

writeFileSync(OUT_DISPLAY, JSON.stringify(displayScript, null, 2), 'utf8');
console.log(`[build_regex] 已生成: ${OUT_DISPLAY}`);
console.log(`  显示正则: ${displayRegex}`);
console.log(`  嵌入HTML大小: ${displayScript.replaceString.length} 字符`);

if (!IS_MOBILE) {
  const stripScript = makeRegexScript({
    id: STRIP_ID,
    scriptName: '状态栏标记清理[上下文]',
    findRegex: `/${MARKER}/g`,
    replaceString: '',
    markdownOnly: false,
    promptOnly: true,
  });

  writeFileSync(OUT_STRIP, JSON.stringify(stripScript, null, 2), 'utf8');
  console.log(`[build_regex] 已生成: ${OUT_STRIP}`);
  console.log(`  清理正则: ${stripScript.findRegex}`);
}
