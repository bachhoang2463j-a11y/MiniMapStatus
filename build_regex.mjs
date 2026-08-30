#!/usr/bin/env node
/**
 * build_regex.mjs — 从 MiniMapStatus.html 自动生成 SillyTavern 正则脚本 JSON
 *
 * 用法：
 *   node build_regex.mjs
 *
 * 产物（每次运行重新生成，保持与 HTML 源码同步）：
 *   1. regex-美化状态栏[独立更新].json
 *      显示用正则（仅格式显示）：把楼层中的「【状态栏标记点】」或旧式
 *      <Status_block>…</Status_block>（取最后一个，连同其后所有内容）替换为
 *      小部件 HTML 代码块，由酒馆助手渲染为 iframe。
 *   2. regex-状态栏标记清理[上下文].json
 *      提示词用正则（仅格式提示词）：从发给 AI 的上下文中剥离标记点，节省 token。
 *
 * 导入方式：SillyTavern → 扩展 → 正则（Regex）→ 导入脚本。
 * 两个脚本使用固定 UUID，重新构建导入时会覆盖更新同 id 脚本（若产生重复条目，
 * 删除旧条目即可）。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, 'MiniMapStatus.html');
const OUT_DISPLAY = join(__dirname, 'regex-美化状态栏[独立更新].json');
const OUT_STRIP = join(__dirname, 'regex-状态栏标记清理[上下文].json');

// 固定 id：重复导入时保持同一身份，避免多副本
const DISPLAY_ID = '43f2c434-708b-467e-b9fd-dac04dc1d80e';
const STRIP_ID = '3288eda7-da4d-4021-9b85-02f6f1026b42';

const MARKER = '【状态栏标记点】';

function buildWidgetReplacement() {
  let html = readFileSync(SRC, 'utf8');
  // 剥离源文件首尾可能残留的 markdown 围栏，避免破坏外层代码块
  html = html.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');
  if (!/<\/html>/i.test(html)) {
    throw new Error('MiniMapStatus.html 内容异常：未找到 </html>');
  }
  return '```\n' + html + '\n```';
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

// 显示正则：标记点 或 最后一个 <Status_block>（连同其后所有内容一并吞掉，
// 避免正文 AI 在标记后追加的杂项文本残留在小部件之外）
const displayRegex = `/(?:${MARKER}|<Status_block>(?![\\s\\S]*?<Status_block>)[\\s\\S]*?<\\/Status_block>)[\\s\\S]*$/i`;

const displayScript = makeRegexScript({
  id: DISPLAY_ID,
  scriptName: '美化状态栏[独立更新]',
  findRegex: displayRegex,
  replaceString: buildWidgetReplacement(),
  markdownOnly: true,
  promptOnly: false,
});

const stripScript = makeRegexScript({
  id: STRIP_ID,
  scriptName: '状态栏标记清理[上下文]',
  findRegex: `/${MARKER}/g`,
  replaceString: '',
  markdownOnly: false,
  promptOnly: true,
});

writeFileSync(OUT_DISPLAY, JSON.stringify(displayScript, null, 2), 'utf8');
writeFileSync(OUT_STRIP, JSON.stringify(stripScript, null, 2), 'utf8');

console.log(`[build_regex] 已生成: ${OUT_DISPLAY}`);
console.log(`  显示正则: ${displayRegex}`);
console.log(`  嵌入HTML大小: ${displayScript.replaceString.length} 字符`);
console.log(`[build_regex] 已生成: ${OUT_STRIP}`);
console.log(`  清理正则: ${stripScript.findRegex}`);
