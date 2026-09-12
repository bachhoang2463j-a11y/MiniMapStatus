#!/usr/bin/env node
/**
 * build_tailwind.mjs — 构建期编译 Tailwind 工具类 CSS 并内联回 MiniMapStatus.html
 *
 * 背景：源 HTML 原先加载 cdn.tailwindcss.com 运行时编译器（每楼 iframe ~110KB 下载，
 * 且与 innerHTML 全量重绘叠加，每次重绘都触发重新扫描编译）。现已移除该 CDN，
 * 改为构建期用 Tailwind CLI（v3，与原 Play CDN 同代语义）扫描源 HTML 生成
 * base/components/utilities 产物 CSS，注入到标记区块内。
 *
 * 用法：
 *   node build_tailwind.mjs [源文件名]   （默认 MiniMapStatus.html，手机版传 MiniMapStatusMobile.html）
 *
 * 何时需要重跑：改动源 HTML 里的 Tailwind 工具类（class="..."），
 * 或修改 tailwind.config.js 主题色/字体之后。跑完再 node build_regex.mjs 重建正则 JSON。
 * 依赖：node + npx（首次运行会下载 tailwindcss@3 到 npm 缓存，之后离线可用缓存）。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_NAME = process.argv[2] || 'MiniMapStatus.html';
const SRC = join(__dirname, SRC_NAME);
const CONFIG = join(__dirname, 'tailwind.config.js');
const TMP = join(__dirname, '_tailwind_tmp');
// 与原 cdn.tailwindcss.com（v3 系列）保持同代语义
const TAILWIND_VERSION = '3.4.17';

// 标记区块（与源 HTML 中的占位注释配套；产物生成后占据两标记之间）。
// 注意：不带前导缩进——替换区间从 START 的 "<!--" 起到 END 的 "-->" 止，
// 行首既有缩进保留在区间之外，避免重复构建时缩进叠加。
const BLOCK_START = '<!-- TAILWIND BUILD OUTPUT START（构建期由 node build_tailwind.mjs 生成，勿手改） -->';
const BLOCK_END = '<!-- TAILWIND BUILD OUTPUT END -->';
const START_TOKEN = '<!-- TAILWIND BUILD OUTPUT START';
const END_TOKEN = '<!-- TAILWIND BUILD OUTPUT END -->';

function fail(msg) {
  console.error(`[build_tailwind] 错误: ${msg}`);
  process.exit(1);
}

function main() {
  const html = readFileSync(SRC, 'utf8');
  const startIdx = html.indexOf(START_TOKEN);
  const endIdx = html.indexOf(END_TOKEN);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    fail(`未找到 TAILWIND BUILD OUTPUT 标记区块，请检查 ${SRC_NAME}`);
  }

  // 扫描用副本：剔除标记区块（含上一次注入的产物 CSS），避免把产物选择器文本当作类名候选
  const blockEndLen = html.slice(endIdx).indexOf('-->') + 3;
  const scanHtml = html.slice(0, startIdx) + html.slice(endIdx + blockEndLen);

  mkdirSync(TMP, { recursive: true });
  try {
    const scanFile = join(TMP, 'scan.html');
    writeFileSync(scanFile, scanHtml);

    const inputFile = join(TMP, 'input.css');
    writeFileSync(
      inputFile,
      '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n'
    );

    const outFile = join(TMP, 'out.css');
    const cmd =
      `npx -y tailwindcss@${TAILWIND_VERSION}` +
      ` -i "${inputFile}" -o "${outFile}" -c "${CONFIG}" --content "${scanFile}" --minify`;
    console.log(`[build_tailwind] 运行: ${cmd}`);
    execSync(cmd, { cwd: __dirname, stdio: 'pipe' });

    const css = readFileSync(outFile, 'utf8').trim();
    if (!css || css.length < 1000) fail(`产物 CSS 异常（${css.length} 字符）`);
    // 基本完整性抽查：preflight（box-sizing）与常用工具类应存在（minify 后无空格；
    // autoprefixer 会把 ::before 写成 :before，故不探伪元素写法）
    for (const probe of ['box-sizing:border-box', 'display:flex', 'rounded']) {
      if (!css.includes(probe)) fail(`产物 CSS 缺少预期内容: ${probe}`);
    }

    // 注入回源文件（替换整个旧区块，含旧注释行；区间外保留行首缩进与行尾换行）
    const newBlock = `${BLOCK_START}\n    <style>\n${css}\n    </style>\n    ${BLOCK_END}`;
    const injected =
      html.slice(0, startIdx) +
      newBlock +
      html.slice(endIdx + blockEndLen);
    writeFileSync(SRC, injected);

    console.log(`[build_tailwind] 产物 CSS: ${css.length} 字符（${(css.length / 1024).toFixed(1)} KB，已 minify）`);
    console.log(`[build_tailwind] ${SRC_NAME} 现大小: ${(Buffer.byteLength(injected, 'utf8') / 1024).toFixed(1)} KB`);
    console.log('[build_tailwind] 完成。请接着运行 node build_regex.mjs 重建正则 JSON。');
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

main();
