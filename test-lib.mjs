/**
 * test-lib.mjs — 测试共用工具（脚本提取 / 实体解码 / 沙箱导出清单）
 *
 * 供 test-public-release.mjs（公开版门禁）与 test-runtime.mjs（真实方法离线回归）复用，
 * 避免两处各写一份提取逻辑而产生漂移。
 *
 * 纪律：只做"从真实产物里取代码"，不复制任何业务实现——测的必须是产物本身。
 */

import { readFileSync } from 'node:fs';

/** 取全部内联 <script> 块（跳过外链与空块） */
export function extractInlineScripts(html) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/** MMS 主脚本块（以业务常量定位，避免抓到内联依赖块） */
export function extractMainScript(html) {
  const main = extractInlineScripts(html).find((b) => b.includes('MMS_COMBAT_RESULT_VAR'));
  if (!main) throw new Error('未找到 MMS 主脚本块（缺 MMS_COMBAT_RESULT_VAR 标记）');
  return main;
}

/** MMS_IMAGE_DATA 标记块内的源码（含 window.MMS_IMAGE_DATA = {...}; 赋值） */
export function extractImageDataBlock(html) {
  const m = html.match(
    /\/\* ==== MMS_IMAGE_DATA_START ==== \*\/([\s\S]*?)\/\* ==== MMS_IMAGE_DATA_END ==== \*\//,
  );
  if (!m) throw new Error('未找到 MMS_IMAGE_DATA 标记块');
  return m[1];
}

/** 在隔离沙箱中取出内置图片表（不执行任何真实网络/存储） */
export function extractImageData(html) {
  const block = extractImageDataBlock(html);
  const fn = new Function('window', block + '; return window.MMS_IMAGE_DATA;');
  const winStub = {};
  const data = fn(winStub);
  if (!data) throw new Error('window.MMS_IMAGE_DATA 提取失败');
  return data;
}

/**
 * 复刻酒馆管线对代码块内容的实体解码（含无分号旧式实体）。
 * 构建产物把所有 & 改写成 &amp; 以免疫该解码，解码后应与改写前逐字节一致。
 */
const NAMED_ENTITIES = {
  lt: '<', gt: '>', quot: '"', amp: '&', apos: "'",
  not: '¬', copy: '©', reg: '®', times: '×',
};
const ENTITY_RE =
  /&(#[0-9]{1,5};|#x[0-9a-fA-F]{1,5};|amp;|lt;|gt;|quot;|apos;|not;|copy;|reg;|times;|amp|lt|gt|quot|not|copy|reg|times)/g;

export function decodePipeline(text) {
  return String(text).replace(ENTITY_RE, (m) => {
    const body = m.slice(1);
    if (body[0] === '#') {
      return body[1] === 'x' || body[1] === 'X'
        ? String.fromCodePoint(parseInt(body.slice(2, -1), 16))
        : String.fromCodePoint(parseInt(body.slice(1, -1), 10));
    }
    return NAMED_ENTITIES[body.replace(/;$/, '')];
  });
}

/** 读构建产物 JSON，返回 { scriptObj, html }（html = 解码后的内嵌产物） */
export function loadBuiltRegex(jsonPath) {
  const scriptObj = JSON.parse(readFileSync(jsonPath, 'utf8'));
  return { scriptObj, html: decodePipeline(scriptObj.replaceString) };
}
