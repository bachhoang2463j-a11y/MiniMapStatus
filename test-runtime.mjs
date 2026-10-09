#!/usr/bin/env node
/**
 * test-runtime.mjs — 真实 MMS 方法的离线回归入口（Node + vm 沙箱）
 *
 * 与 test-public-release.mjs 的分工：
 *   - test-public-release.mjs：产物门禁（围栏/语法/图片白名单/纯函数）
 *   - 本文件：把**真实主脚本**装进沙箱，调用**真实业务方法**（含异步链路），
 *     验证状态隔离、异步归属、结算幂等、自动更新排重等运行期行为。
 *
 * 关键纪律：
 *   1. 绝不复制业务实现——只从真实产物里取代码运行。
 *   2. mock 必须保真（对齐酒馆助手 src/function/variables.ts、chat_message.ts）：
 *      · getVariables(message) 只读**当前 swipe**、返回**副本**、**不向前继承**
 *      · insertOrAssignVariables = 对象深合并、数组整体替换（lodash mergeWith 语义）
 *      · replaceVariables(message) 整体替换当前 swipe 槽
 *      · getChatMessages(...,{include_swipes:true}) 返回各槽副本
 *      · setChatMessages 分「当前槽」与「整数组写回」两条分支
 *   3. 绝不发起真实网络请求、不读用户聊天/角色卡数据、不碰真实 LLM。
 *
 * 用法：node test-runtime.mjs [--src=private|public|all] [--only=<组名前缀>]
 */

import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMainScript, extractInlineScripts } from './test-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 断言
let passCount = 0;
const failures = [];
function ok(desc, cond, extra) {
  if (cond) {
    passCount++;
    console.log(`  [PASS] ${desc}`);
  } else {
    failures.push(desc);
    console.log(`  [FAIL] ${desc}${extra ? '  — ' + extra : ''}`);
  }
}
function eq(desc, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(desc, a === e, `实际 ${a} / 期望 ${e}`);
}
const sleep = () => new Promise((r) => setImmediate(r));
async function drain(n = 10) {
  for (let i = 0; i < n; i++) await sleep();
}

// ---------------------------------------------------------------- 虚拟时钟
class Clock {
  constructor() {
    this.now = 0;
    this.seq = 0;
    this.tasks = new Map();
    this.errors = [];
  }
  schedule(fn, ms, args) {
    const id = ++this.seq;
    this.tasks.set(id, { due: this.now + (Number(ms) || 0), fn, args: args || [] });
    return id;
  }
  clear(id) {
    this.tasks.delete(id);
  }
  /** 虚拟延时：只有时钟推进到点才 resolve（模拟真实请求占用时间窗） */
  delay(ms) {
    return new Promise((resolve) => {
      this.schedule(() => resolve(), ms, []);
    });
  }
  pendingCount() {
    return this.tasks.size;
  }
  /** 推进虚拟时间：按到期顺序执行回调（含回调内新排的定时器） */
  async advance(ms = 0) {
    const target = this.now + (Number(ms) || 0);
    let guard = 0;
    while (guard++ < 20000) {
      let next = null;
      for (const [id, t] of this.tasks) {
        if (t.due <= target && (!next || t.due < next[1].due)) next = [id, t];
      }
      if (!next) break;
      const [id, t] = next;
      this.tasks.delete(id);
      this.now = Math.max(this.now, t.due);
      // 浏览器语义：定时器回调**不被 await**。异步回调（如 8 秒后的状态更新）
      // 会在下一个回调触发时仍在飞行中——这正是"双 iframe 各排一个 8 秒定时器"
      // 的真实竞争形态，串行等待会把竞争掩盖掉。
      try {
        const r = t.fn(...t.args);
        if (r && typeof r.then === 'function') r.catch((e) => this.errors.push(e));
      } catch (e) {
        this.errors.push(e);
      }
      await drain(4);
    }
    this.now = Math.max(this.now, target);
    await drain();
  }
}

// ---------------------------------------------------------------- 伪 DOM
function makeFakeElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', innerHTML: '', textContent: '', value: '', title: '',
    type: '', href: '', download: '', placeholder: '', name: '',
    disabled: false, checked: false, open: false, files: null,
    style: {}, dataset: {}, children: [], childNodes: [],
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) {
        if (f === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c);
        else f ? this._s.add(c) : this._s.delete(c);
      },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    replaceChild(c) { this.children.push(c); return c; },
    remove() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    // 真实 DOM 里这些子元素是存在的（如卡片内的 .roster-edit-btn），返回桩元素而不是 null，
    // 否则 `card.querySelector('.x').addEventListener(...)` 这类写法会直接抛错
    querySelector(sel) {
      if (!this._q) this._q = new Map();
      if (!this._q.has(sel)) this._q.set(sel, Object.assign(makeFakeElement(), { _sel: sel }));
      return this._q.get(sel);
    },
    querySelectorAll() { return []; },
    closest() { return null; }, focus() {}, blur() {}, click() {}, scrollIntoView() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    offsetWidth: 0, offsetHeight: 0, clientWidth: 0, clientHeight: 0, scrollTop: 0, scrollLeft: 0,
    scrollHeight: 0, contains() { return false; }, matches() { return false; },
    cloneNode() { return makeFakeElement(tag); }, insertAdjacentHTML() {},
    after() {}, before() {}, replaceWith() {}, animate() { return { cancel() {} }; },
    get firstChild() { return this.children[0] || null; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get parentNode() { return null; },
  };
  return el;
}

function makeFakeDocument() {
  const byId = new Map();
  return {
    body: makeFakeElement('body'),
    head: makeFakeElement('head'),
    documentElement: makeFakeElement('html'),
    cookie: '',
    getElementById(id) {
      const key = String(id);
      if (!byId.has(key)) byId.set(key, Object.assign(makeFakeElement(), { id: key }));
      return byId.get(key);
    },
    createElement(tag) { return makeFakeElement(tag); },
    createTextNode(t) { return { textContent: String(t) }; },
    createDocumentFragment() { return makeFakeElement('fragment'); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  };
}

// ---------------------------------------------------------------- 宿主（跨 iframe 共享）
const TAVERN_EVENTS = {
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_DELETED: 'message_deleted',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_ENDED: 'generation_ended',
  GENERATION_STOPPED: 'generation_stopped',
};

function createHost(opts = {}) {
  const host = {
    clock: new Clock(),
    chat: [],
    chatVars: {},
    globalVars: {},
    charVars: {},
    worldbooks: opts.worldbooks || {},
    charWorldbooks: { primary: null, additional: [] },
    charName: opts.charName || '测试角色',
    chatId: opts.chatId || 'test-chat',
    regexes: opts.regexes || { global: [], character: [] },
    listeners: new Map(),
    bcSubs: new Map(),
    localStorage: new Map(opts.localStorage || []),
    genCalls: [],
    genHandler: null,
    genGate: null,
    worldbookGate: null,
    logs: [],
    errors: [],
  };
  if (opts.chat) host.chat.push(...opts.chat);
  if (opts.chatVars) host.chatVars = JSON.parse(JSON.stringify(opts.chatVars));
  if (opts.globalVars) host.globalVars = JSON.parse(JSON.stringify(opts.globalVars));
  host.emit = async (ev, ...args) => {
    const set = host.listeners.get(ev);
    if (!set) return;
    for (const w of [...set]) {
      try { await w(...args); } catch (e) { host.errors.push(e); }
    }
  };
  host.on = (ev, w) => {
    if (!host.listeners.has(ev)) host.listeners.set(ev, new Set());
    host.listeners.get(ev).add(w);
    return w;
  };
  host.off = (ev, w) => { host.listeners.get(ev)?.delete(w); };
  host.listenerCount = () => {
    let n = 0;
    for (const s of host.listeners.values()) n += s.size;
    return n;
  };
  host.eventSource = { on: host.on, off: host.off, removeListener: host.off, emit: host.emit };
  // 宿主页 window 桩：所有 iframe 共享同一个 parent 对象（跨 iframe 共享状态就挂在这里）
  host.parentStub = {
    SillyTavern: {
      getContext: () => ({
        chat: host.chat,
        eventSource: host.eventSource,
        eventTypes: TAVERN_EVENTS,
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test' }),
        getCurrentChatId: () => host.chatId,
      }),
    },
    document: makeFakeDocument(),
  };
  return host;
}

/** 追加一条楼层消息；variables 按 swipe 索引给初值 */
function pushMessage(host, { mes = '', is_user = false, swipes, variables, swipe_id = 0 } = {}) {
  const swipeArr = (swipes || [mes]).slice();
  const msg = {
    mes: swipeArr[swipe_id] ?? mes,
    is_user,
    is_system: false,
    swipe_id,
    swipes: swipeArr,
    swipe_info: swipeArr.map(() => ({})),
    variables: swipeArr.map((_, i) => (variables && variables[i]) || {}),
    extra: {},
  };
  host.chat.push(msg);
  return host.chat.length - 1;
}

// ---------------------------------------------------------------- 酒馆助手接口 mock
function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (
      v && typeof v === 'object' && !Array.isArray(v) &&
      target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])
    ) {
      deepMerge(target[k], v);
    } else {
      target[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
  }
  return target;
}

function mmsGetVariables(host, opt = { type: 'chat' }) {
  switch (opt.type) {
    case 'chat': return JSON.parse(JSON.stringify(host.chatVars));
    case 'global': return JSON.parse(JSON.stringify(host.globalVars));
    case 'character': return JSON.parse(JSON.stringify(host.charVars));
    case 'message': {
      const latest = opt.message_id === undefined || opt.message_id === 'latest';
      let id = opt.message_id;
      if (latest) {
        for (let i = host.chat.length - 1; i >= 0; i--) {
          if (!host.chat[i].is_system) { id = i; break; }
        }
      }
      const msg = host.chat[id];
      if (!msg) return {};
      const slot = msg.variables ? msg.variables[msg.swipe_id ?? 0] ?? {} : {};
      return JSON.parse(JSON.stringify(slot));
    }
    default: return {};
  }
}

function mmsInsertOrAssign(host, vars, opt = { type: 'chat' }) {
  if (opt.type === 'chat') return deepMerge(host.chatVars, vars);
  if (opt.type === 'global') return deepMerge(host.globalVars, vars);
  if (opt.type === 'character') return deepMerge(host.charVars, vars);
  if (opt.type === 'message') {
    const msg = host.chat[opt.message_id];
    if (!msg) return vars;
    if (!Array.isArray(msg.variables)) msg.variables = [];
    const idx = msg.swipe_id ?? 0;
    if (!msg.variables[idx]) msg.variables[idx] = {};
    return deepMerge(msg.variables[idx], vars);
  }
  return vars;
}

function mmsReplaceVariables(host, vars, opt = { type: 'chat' }) {
  if (opt.type === 'chat') { host.chatVars = vars; return; }
  if (opt.type === 'global') { host.globalVars = vars; return; }
  if (opt.type === 'character') { host.charVars = vars; return; }
  if (opt.type === 'message') {
    const id = opt.message_id === undefined || opt.message_id === 'latest'
      ? host.chat.length - 1 : opt.message_id;
    const msg = host.chat[id];
    if (!msg) return;
    if (!Array.isArray(msg.variables)) {
      msg.variables = Array.from({ length: msg.swipes?.length ?? 1 }, () => ({}));
    }
    msg.variables[msg.swipe_id ?? 0] = vars;
  }
}

function mmsRangeIds(range, host) {
  if (typeof range === 'number') return [range];
  const s = String(range);
  const m = s.match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  const n = Number(s);
  return Number.isFinite(n) ? [n] : [];
}

function mmsGetChatMessages(host, range, opts = {}) {
  const { include_swipes = false, role = 'all' } = opts;
  const out = [];
  for (const id of mmsRangeIds(range, host)) {
    const msg = host.chat[id];
    if (!msg) continue;
    const msgRole = msg.is_user ? 'user' : 'assistant';
    if (role !== 'all' && msgRole !== role) continue;
    const swipe_id = msg.swipe_id ?? 0;
    const swipes = (msg.swipes || [msg.mes]).slice();
    const swipes_data = swipes.map((_, i) => msg.variables?.[i] ?? {});
    const swipes_info = swipes.map((_, i) => msg.swipe_info?.[i] ?? {});
    if (include_swipes) {
      out.push({ message_id: id, name: msg.name, role: msgRole, is_hidden: !!msg.is_system, swipe_id, swipes, swipes_data, swipes_info });
    } else {
      out.push({
        message_id: id, name: msg.name, role: msgRole, is_hidden: !!msg.is_system,
        message: msg.mes ?? '', data: swipes_data[swipe_id], extra: swipes_info[swipe_id],
        swipe_id, swipes, swipes_data,
      });
    }
  }
  return JSON.parse(JSON.stringify(out));
}

async function mmsSetChatMessages(host, list, opts = {}) {
  const { refresh = 'affected' } = opts;
  for (const item of list) {
    const msg = host.chat[item.message_id];
    if (!msg) continue;
    const hasPlain = 'message' in item || 'data' in item;
    if (hasPlain) {
      if (item.message !== undefined) {
        msg.mes = item.message;
        if (msg.swipes) msg.swipes[msg.swipe_id ?? 0] = item.message;
      }
      if (item.data !== undefined) {
        if (!Array.isArray(msg.variables)) {
          msg.variables = Array.from({ length: msg.swipes?.length ?? 1 }, () => ({}));
        }
        msg.variables[msg.swipe_id ?? 0] = item.data;
      }
      if (item.extra !== undefined) msg.extra = item.extra;
    } else if (
      item.swipe_id !== undefined || item.swipes !== undefined ||
      item.swipes_data !== undefined || item.swipes_info !== undefined
    ) {
      const maxLen = Math.max(
        item.swipes?.length ?? 0, item.swipes_data?.length ?? 0, item.swipes_info?.length ?? 0,
      ) || msg.swipes?.length || 1;
      const sid = Math.min(Math.max(item.swipe_id ?? msg.swipe_id ?? 0, 0), maxLen - 1);
      msg.swipes = Array.from({ length: maxLen }, (_, i) => item.swipes?.[i] ?? '');
      msg.variables = Array.from({ length: maxLen }, (_, i) => item.swipes_data?.[i] ?? {});
      msg.swipe_info = Array.from({ length: maxLen }, (_, i) => item.swipes_info?.[i] ?? {});
      msg.swipe_id = sid;
      msg.mes = msg.swipes[sid];
      msg.extra = msg.swipe_info[sid];
    }
  }
  if (refresh === 'all') await host.emit(TAVERN_EVENTS.CHAT_CHANGED, 'test-chat');
  else if (refresh === 'affected') await host.emit('message_updated', list[0]?.message_id);
}

// ---------------------------------------------------------------- 实例（一个 iframe）
function createInstance(host, { floorId = 0, scriptText, jsyamlBlock }) {
  const doc = makeFakeDocument();
  const sandbox = {};
  const instance = { host, floorId, listeners: new Set(), bc: [], destroyed: false, doc };

  const LS = {
    getItem: (k) => (host.localStorage.has(String(k)) ? host.localStorage.get(String(k)) : null),
    setItem: (k, v) => { host.localStorage.set(String(k), String(v)); },
    removeItem: (k) => { host.localStorage.delete(String(k)); },
    clear: () => host.localStorage.clear(),
  };

  Object.assign(sandbox, {
    console: {
      log: (...a) => host.logs.push(['log', ...a]),
      info: (...a) => host.logs.push(['info', ...a]),
      warn: (...a) => host.logs.push(['warn', ...a]),
      error: (...a) => host.errors.push(a[0]),
      debug: (...a) => host.logs.push(['debug', ...a]),
    },
    document: doc,
    localStorage: LS,
    setTimeout: (fn, ms, ...a) => host.clock.schedule(fn, ms, a),
    clearTimeout: (id) => host.clock.clear(id),
    setInterval: () => 0,
    clearInterval: () => {},
    alert: (m) => host.logs.push(['alert', m]),
    confirm: () => true,
    prompt: () => '',
    fetch: () => Promise.reject(new Error('测试环境禁止真实网络请求')),
    BroadcastChannel: class {
      constructor(name) {
        this.name = name;
        if (!host.bcSubs.has(name)) host.bcSubs.set(name, new Set());
        host.bcSubs.get(name).add(this);
        instance.bc.push(this);
      }
      postMessage(data) {
        for (const o of host.bcSubs.get(this.name) || []) {
          if (o !== this && typeof o.onmessage === 'function') o.onmessage({ data });
        }
      }
      close() { host.bcSubs.get(this.name)?.delete(this); }
    },
    getVariables: (opt) => mmsGetVariables(host, opt),
    insertOrAssignVariables: (v, opt) => mmsInsertOrAssign(host, v, opt),
    replaceVariables: (v, opt) => mmsReplaceVariables(host, v, opt),
    getChatMessages: (range, opts) => mmsGetChatMessages(host, range, opts),
    setChatMessages: (list, opts) => mmsSetChatMessages(host, list, opts),
    getCurrentMessageId: () => instance.floorId,
    getLastMessageId: () => host.chat.length - 1,
    getCurrentMessage: () => mmsGetChatMessages(host, instance.floorId)[0] || null,
    eventOn: (ev, fn) => {
      const wrapper = (...a) => fn(...a);
      host.on(ev, wrapper);
      instance.listeners.add({ ev, wrapper });
      return { stop: () => host.off(ev, wrapper) };
    },
    eventEmit: (ev, ...a) => host.emit(ev, ...a),
    tavern_events: TAVERN_EVENTS,
    generateRaw: async (cfg) => {
      host.genCalls.push(cfg);
      // 真实 LLM 请求要占用数秒：用虚拟延时建模，否则"两个 8 秒定时器"的竞争
      // 会被瞬间返回的 mock 掩盖（排重逻辑看起来失效，实则是测试不真实）
      if (host.genLatencyMs) await host.clock.delay(host.genLatencyMs);
      if (host.genGate) await host.genGate;
      if (!host.genHandler) throw new Error('测试未设置 genHandler');
      const r = host.genHandler(cfg, host.genCalls.length);
      return typeof r === 'string' ? r : await r;
    },
    getCharWorldbookNames: () => ({ ...host.charWorldbooks }),
    getWorldbook: async (name) => {
      if (host.worldbookGate) await host.worldbookGate;
      return JSON.parse(JSON.stringify(host.worldbooks[name] || []));
    },
    updateWorldbookWith: async (name, fn) => {
      if (host.worldbookGate) await host.worldbookGate;
      host.worldbooks[name] = fn(JSON.parse(JSON.stringify(host.worldbooks[name] || [])));
    },
    createWorldbook: async (name) => { host.worldbooks[name] = host.worldbooks[name] || []; return true; },
    createWorldbookEntries: async (name, entries) => {
      host.worldbooks[name] = (host.worldbooks[name] || []).concat(JSON.parse(JSON.stringify(entries)));
    },
    rebindCharWorldbooks: async (_who, cfg) => { host.charWorldbooks = cfg; },
    getCurrentCharacterName: () => host.charName,
    initializeGlobal: (k, v) => { host.globals = host.globals || {}; host.globals[k] = v; },
    getTavernRegexes: async (opt) => JSON.parse(JSON.stringify(
      opt && opt.type === 'character' ? host.regexes.character : host.regexes.global,
    )),
    replaceTavernRegexes: async (list, opt) => {
      if (opt && opt.type === 'character') host.regexes.character = list;
      else host.regexes.global = list;
    },
    triggerSlash: () => {},
  });

  vm.createContext(sandbox);
  // iframe 里 window 就是全局对象；parent 指向宿主页（同一 host 的多个 iframe 共用同一个 parent 对象）
  vm.runInContext('globalThis.window = globalThis;', sandbox);
  sandbox.parent = host.parentStub;
  vm.runInContext('globalThis.window.parent = globalThis.parent;', sandbox);

  if (jsyamlBlock) vm.runInContext(jsyamlBlock, sandbox);
  if (!sandbox.jsyaml) throw new Error('js-yaml 未能在沙箱中注册（检查 INLINE-DEP 块）');

  vm.runInContext(scriptText, sandbox);
  if (!sandbox.MMS) throw new Error('MMS 未挂载到 window');

  instance.sandbox = sandbox;
  instance.MMS = sandbox.MMS;
  return instance;
}

/** 模拟 iframe 被销毁（酒馆助手在 pagehide 时清掉本 iframe 的事件监听） */
function destroyInstance(instance) {
  for (const { ev, wrapper } of instance.listeners) instance.host.off(ev, wrapper);
  instance.listeners.clear();
  for (const ch of instance.bc) { instance.host.bcSubs.get(ch.name)?.delete(ch); }
  instance.bc = [];
  instance.destroyed = true;
}

// ---------------------------------------------------------------- 版本配置
const SOURCES = [
  {
    key: 'private', label: '非公开完整版',
    html: 'MiniMapStatus.html',
    json: 'regex-美化状态栏[独立更新].json',
    id: '43f2c434-708b-467e-b9fd-dac04dc1d80e',
    name: '美化状态栏[独立更新]',
    isPublic: false,
    imgKey: 'mms_img_data_llm_v1',
  },
  {
    key: 'public', label: '公开版',
    html: 'MiniMapStatus-公开版.html',
    json: 'regex-美化状态栏[公开版].json',
    id: '2b8a7c13-e4d5-4a7f-9b1a-8e2c3d4f5a6b',
    name: '美化状态栏[公开版]',
    isPublic: true,
    // 修复目标：公开版使用独立键，避免被非公开版本机快照整表覆盖
    imgKey: 'mms_img_data_public_v1',
  },
];

function loadVersion(S) {
  const html = readFileSync(join(__dirname, S.html), 'utf8');
  const scriptText = extractMainScript(html);
  const jsyamlBlock = extractInlineScripts(html).find((b) => b.includes('INLINE-DEP js-yaml START'));
  if (!jsyamlBlock) throw new Error('未找到内联 js-yaml 块');
  return { S, html, scriptText, jsyamlBlock };
}

// ---------------------------------------------------------------- 公共夹具
const STATE_MODULE = {
  状态栏: {
    日期和时间: '⏰ 1925年 · 6月13日 · 12:40',
    地点: '📍 悉尼 · 酒店',
    据点: { 名称: '酒店套房', 现金: '520美元', 物资: '[绷带x2]' },
    角色列表: [{ 角色: { 名字: '李娟', 属性: '[❤️HP:19/28][💧MP:3/14]' } }],
  },
};

function makeRoster(extra = {}) {
  return Object.assign({
    characters: [{ name: '李娟', attrs: [{ key: '❤️HP', value: '28/28' }, { key: '💧MP', value: '14/14' }] }],
    modules: [],
    maps: { minimap: true, bigmap: false },
    mapTags: { pool: [], mini: ['客厅'], big: [] },
    bigmapArt: { enabled: false, note: '', style: 'flat' },
    miniArt: { enabled: false, note: '', style: 'flat' },
    absentThreshold: 3,
    charDisplayMode: 'full',
  }, extra);
}

const BILL = {
  id: 'nd-99-abc', floorId: 99, date: '1925年1月17日', days: 1,
  cashBefore: 520, totalCost: 65,
  items: [{ category: '住宿', cost: 12, details: '客房' }],
};

/** 一个可直接用的场景：带状态的楼层 + 名册 */
function sceneWithState(V, { floorText = '正文内容', state = STATE_MODULE } = {}) {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const id = pushMessage(host, { mes: floorText, variables: [{ stat_data: state, $mms_meta: { hash: 'x', ts: 1, mesId: 0 } }] });
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  return { host, inst, id };
}

// ---------------------------------------------------------------- 测试组
const GROUPS = [];
function group(name, fn) { GROUPS.push({ name, fn }); }

// ============ R1 每日结算：双通道通知不得重复扣款 ============
group('R1-结算幂等', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const id = pushMessage(host, {
    mes: '第一天结束',
    variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }],
  });
  // 世界书闸门：模拟 ensureInjection 的异步等待窗口
  let releaseGate;
  host.worldbookGate = new Promise((r) => { releaseGate = r; });
  host.charWorldbooks = { primary: '测试世界书', additional: [] };
  host.worldbooks['测试世界书'] = [];

  const a = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  const b = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  a.MMS.detectEnv();
  b.MMS.detectEnv();
  a.MMS.floorId = id;
  b.MMS.floorId = id;

  // 双通道：事件 + BroadcastChannel 几乎同时到达
  const p1 = a.MMS.applyNewdayBill(JSON.parse(JSON.stringify(BILL)));
  await drain();
  const p2 = b.MMS.applyNewdayBill(JSON.parse(JSON.stringify(BILL)));
  await drain();
  releaseGate();
  await Promise.allSettled([p1, p2]);
  await drain();

  const slot = host.chat[id].variables[0].stat_data['状态栏'];
  eq('账单只扣一次现金（520 − 65 = 455）', slot['据点']['现金'], '455美元');
  ok('回血只应用一次（李娟 HP 25/28）', slot['角色列表'][0]['角色']['属性'].includes('[❤️HP:25/28]'),
    `实际 ${slot['角色列表'][0]['角色']['属性']}`);
});

// ============ R2 自动更新：旧楼代理 + 新楼 boot 只应请求一次 ============
group('R2-自动更新排重', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  // 先只有 0..N-1，让旧楼实例 boot 时自认"最后一个 AI 楼"
  pushMessage(host, { mes: '第一楼正文' });
  const prevId = pushMessage(host, { mes: '第二楼正文' });
  const oldInst = createInstance(host, { floorId: prevId, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  await oldInst.MMS.boot();
  await drain();
  ok('旧楼实例 boot 后自认最后一个 AI 楼', oldInst.MMS.isLastAssistantFloor === true);

  // 新 AI 楼到达（无状态、无标记点）
  const newId = pushMessage(host, { mes: '第三楼正文，没有任何状态' });
  const newInst = createInstance(host, { floorId: newId, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });

  host.genHandler = () => JSON.stringify(STATE_MODULE);
  // 请求占用 2 秒（虚拟时间）：两个 8 秒定时器几乎同时触发，第二个必须复用第一个的请求
  host.genLatencyMs = 2000;
  // 事件通道：旧楼实例代理触发；随后新楼 iframe 渲染完成
  await host.emit(TAVERN_EVENTS.MESSAGE_RECEIVED, newId);
  await newInst.MMS.boot();
  await drain();

  await host.clock.advance(9000); // 两个 8 秒定时器触发（此时请求仍在飞行）
  await host.clock.advance(6000); // 让请求跑完
  await drain();
  const targetCalls = host.genCalls.filter((c) => c.generation_id && c.generation_id.startsWith('mms-update-' + newId + '-'));
  ok('同一新楼层只发起 1 次状态更新请求', targetCalls.length === 1, `实际 ${targetCalls.length} 次`);
});

// ============ R2b/R2c/R2d 排重的其余边界 ============
group('R2b-重复通知不额外请求', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  pushMessage(host, { mes: '第一楼' });
  const prevId = pushMessage(host, { mes: '第二楼' });
  const oldInst = createInstance(host, { floorId: prevId, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  await oldInst.MMS.boot();
  await drain();
  const newId = pushMessage(host, { mes: '第三楼' });
  host.genHandler = () => JSON.stringify(STATE_MODULE);
  host.genLatencyMs = 2000;

  // 同一条通知重复到达三次（事件重放/多实例同时收到）
  await host.emit(TAVERN_EVENTS.MESSAGE_RECEIVED, newId);
  await host.emit(TAVERN_EVENTS.MESSAGE_RECEIVED, newId);
  await host.emit(TAVERN_EVENTS.MESSAGE_RECEIVED, newId);
  await drain();
  await host.clock.advance(9000);
  await host.clock.advance(6000);
  await drain();

  const calls = host.genCalls.filter((c) => c.generation_id && c.generation_id.includes('-' + newId + '-'));
  ok('重复通知只产生 1 次请求', calls.length === 1, `实际 ${calls.length} 次`);
});

group('R2c-关闭自动更新后不发请求', async (V) => {
  const host = createHost({
    chatVars: { $mms_roster: makeRoster() },
    globalVars: { $mms_config: { autoUpdate: false } },
  });
  pushMessage(host, { mes: '第一楼' });
  const id = pushMessage(host, { mes: '第二楼，无状态' });
  host.genHandler = () => JSON.stringify(STATE_MODULE);
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  await inst.MMS.boot();
  await drain();
  await host.clock.advance(20000);
  await drain();
  ok('autoUpdate=false 时不发起状态更新请求', host.genCalls.length === 0, `实际 ${host.genCalls.length} 次`);
});

group('R2d-真正的新楼不漏更新', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  pushMessage(host, { mes: '第一楼' });
  const id = pushMessage(host, { mes: '第二楼，无状态' });
  host.genHandler = () => JSON.stringify(STATE_MODULE);
  host.genLatencyMs = 2000;
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  await inst.MMS.boot();
  await drain();
  await host.clock.advance(9000);
  await host.clock.advance(6000);
  await drain();
  ok('新楼 boot 自行触发 1 次请求', host.genCalls.length === 1, `实际 ${host.genCalls.length} 次`);
  ok('新楼状态已写入', !!host.chat[id].variables[0]?.stat_data, JSON.stringify(host.chat[id].variables[0]));
});

// ============ R1b 结算台账的失败/重放边界 ============
group('R1b-结算台账边界', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const id = pushMessage(host, {
    mes: '第一天结束',
    variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }],
  });
  let releaseGate;
  host.worldbookGate = new Promise((r) => { releaseGate = r; });
  host.charWorldbooks = { primary: '测试世界书', additional: [] };
  host.worldbooks['测试世界书'] = [];
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = id;

  // ① 身份守卫：切聊天后目标即失效；且此刻尚未落任何台账（可重试）
  const target = inst.MMS.captureTarget(id);
  host.chatId = 'other-chat';
  ok('切聊天后目标判定为失效', inst.MMS.isTargetAlive(target) === false);
  ok('失效时台账未被写入', inst.MMS.loadNewdaySync().lastId !== BILL.id,
    `lastId=${JSON.stringify(inst.MMS.loadNewdaySync().lastId)}`);
  host.chatId = 'test-chat';
  ok('切回后目标恢复有效', inst.MMS.isTargetAlive(inst.MMS.captureTarget(id)) === true);

  // ② 世界书注入被闸门挡住（异步未完成）时，结算必须已经写盘并落台账
  const p1 = inst.MMS.applyNewdayBill(JSON.parse(JSON.stringify(BILL)));
  await drain();
  eq('注入未完成时结算已写盘（现金 455）', host.chat[id].variables[0].stat_data['状态栏']['据点']['现金'], '455美元');
  ok('写盘成功后台账立刻落（不等注入）', inst.MMS.loadNewdaySync().lastId === BILL.id,
    `lastId=${JSON.stringify(inst.MMS.loadNewdaySync().lastId)}`);

  // ③ 同账单重放：不再扣款
  await inst.MMS.applyNewdayBill(JSON.parse(JSON.stringify(BILL)));
  await drain();
  eq('同账单重放不重复扣款', host.chat[id].variables[0].stat_data['状态栏']['据点']['现金'], '455美元');

  releaseGate();
  await p1;
  await drain();
  eq('注入完成后金额不变（注入延迟/失败不影响结算）', host.chat[id].variables[0].stat_data['状态栏']['据点']['现金'], '455美元');

  // ④ 新账单正常处理
  const bill2 = Object.assign({}, BILL, { id: 'nd-100-def', totalCost: 10 });
  await inst.MMS.applyNewdayBill(bill2);
  await drain();
  eq('新账单正常扣款（455 − 10 = 445）', host.chat[id].variables[0].stat_data['状态栏']['据点']['现金'], '445美元');
});

// ============ R3 API 预设：切回默认必须清空旧端点 ============
group('R3-API预设残留', async (V) => {
  const host = createHost({
    chatVars: { $mms_roster: makeRoster() },
    localStorage: [],
  });
  const id = pushMessage(host, { mes: '正文', variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }] });
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = id;

  // 先配置一个自定义独立端点
  inst.MMS.saveConfig(Object.assign(inst.MMS.loadConfig(), {
    apiUrl: 'http://old-endpoint.example/v1', apiKey: 'sk-old', model: 'old-model', preset: '旧代理预设',
  }));
  inst.MMS.saveApiPresets({
    active: 'custom1',
    presets: [
      { id: 'default', name: '默认（当前酒馆连接）', config: {}, locked: true },
      { id: 'custom1', name: '自定义', config: { apiUrl: 'http://old-endpoint.example/v1', apiKey: 'sk-old', model: 'old-model', preset: '旧代理预设' }, locked: false },
    ],
  });

  // 切回默认预设
  inst.MMS.syncActiveApiToConfig({ active: 'default', presets: [{ id: 'default', name: '默认（当前酒馆连接）', config: {}, locked: true }] });

  const cfg = inst.MMS.loadConfig();
  eq('切回默认后 apiUrl 已清空', cfg.apiUrl || '', '');
  eq('切回默认后 model 已清空', cfg.model || '', '');
  eq('切回默认后 apiKey 已清空', cfg.apiKey || '', '');
  eq('切回默认后代理预设名已清空', cfg.preset || '', '');

  // 端到端：真实请求参数里不得带旧端点
  host.genHandler = () => JSON.stringify(STATE_MODULE);
  await inst.MMS.runUpdate(id);
  const api = host.genCalls[host.genCalls.length - 1]?.custom_api || {};
  ok('实际请求未携带旧端点', !api.apiurl && !api.key && !api.model && !api.proxy_preset,
    `custom_api=${JSON.stringify(api)}`);
});

// ============ R4 图片「保存到源码」必须命中本版本正则 ============
group('R4-图片写回目标', async (V) => {
  const mkRegex = (id, name) => ({
    id, script_name: name, replace_string: '前置代码\n/* ==== MMS_IMAGE_DATA_START ==== */\nwindow.MMS_IMAGE_DATA = {};\n/* ==== MMS_IMAGE_DATA_END ==== */\n后置代码',
  });
  // 两版同时存在，且把"非本版本"排在前面（真实场景：旧版未删除/未禁用）
  const other = V.S.isPublic
    ? mkRegex('43f2c434-708b-467e-b9fd-dac04dc1d80e', '美化状态栏[独立更新]')
    : mkRegex('2b8a7c13-e4d5-4a7f-9b1a-8e2c3d4f5a6b', '美化状态栏[公开版]');
  const mine = mkRegex(V.S.id, V.S.name);
  const host = createHost({
    regexes: { global: [other, mine], character: [] },
    chatVars: { $mms_roster: makeRoster() },
  });
  const id = pushMessage(host, { mes: '正文' });
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = id;
  inst.MMS.initImageUI();
  inst.MMS.imageData.avatar['新头像'] = 'https://example.com/a.png';

  await inst.MMS.saveImageDataToSource();
  await drain();

  const after = host.regexes.global;
  const mineAfter = after.find((r) => r.id === V.S.id);
  const otherAfter = after.find((r) => r.id !== V.S.id);
  ok('本版本正则被写入新条目', String(mineAfter.replace_string).includes('新头像'));
  ok('另一版本正则未被改动', !String(otherAfter.replace_string).includes('新头像'));
});

// ============ R4b 身份无法唯一确定时必须拒绝写入 ============
group('R4b-身份歧义拒绝', async (V) => {
  const mkRegex = (id, name) => ({
    id, script_name: name, replace_string: '/* ==== MMS_IMAGE_DATA_START ==== */\nwindow.MMS_IMAGE_DATA = {};\n/* ==== MMS_IMAGE_DATA_END ==== */',
  });
  // 同一版本被导入两次（UUID 不同、脚本名相同）→ 无法确定承载本页面的那一条
  const host = createHost({
    regexes: { global: [mkRegex('dup-a', V.S.name), mkRegex('dup-b', V.S.name)], character: [] },
    chatVars: { $mms_roster: makeRoster() },
  });
  const id = pushMessage(host, { mes: '正文' });
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = id;
  inst.MMS.initImageUI();
  inst.MMS.imageData.avatar['新头像'] = 'https://example.com/a.png';

  await inst.MMS.saveImageDataToSource();
  await drain();

  const untouched = host.regexes.global.every((r) => !String(r.replace_string).includes('新头像'));
  ok('身份歧义时两条正则都未被写入', untouched);
  ok('身份歧义时给出提示', host.logs.some(([k, m]) => k === 'alert' && String(m).includes('无法确定')),
    JSON.stringify(host.logs.filter(([k]) => k === 'alert')));
});

// ============ R5 公开版图片表不得被非公开版本机快照覆盖 ============
group('R5-公开版图片隔离', async (V) => {
  if (!V.S.isPublic) {
    ok('（仅公开版适用，非公开版跳过）', true);
    return;
  }
  // 模拟"用户此前用过非公开版，本机已存旧角色快照"
  const legacySnapshot = JSON.stringify({
    portrait: { 弗兰克: 'https://example.com/frank.png' },
    avatar: { 弗兰克: 'https://example.com/frank-avatar.png' },
    background: { 棋盘: 'https://example.com/chess.png' },
  });
  const host = createHost({ localStorage: [['mms_img_data_llm_v1', legacySnapshot]] });
  pushMessage(host, { mes: '正文' });
  const inst = createInstance(host, { floorId: 0, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  const data = inst.sandbox.window.MMS_IMAGE_DATA;
  ok('公开版内置图片表未被旧快照整表覆盖（无旧角色）', !data.portrait['弗兰克'],
    `实际 portrait 键=${JSON.stringify(Object.keys(data.portrait))}`);
  ok('公开版未改写非公开版的旧快照键', host.localStorage.get('mms_img_data_llm_v1') === legacySnapshot);
  ok('公开版头像导出键与非公开版隔离',
    inst.sandbox.window.MMS_AVATAR_EXPORT_KEY !== 'mms_avatar_export_v1',
    `实际 ${inst.sandbox.window.MMS_AVATAR_EXPORT_KEY}`);
});

// ============ R6 swipe 编辑不得污染旧槽 ============
group('R6-swipe编辑隔离', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  // 槽0 = 已有状态；槽1 = 新 swipe（空）——用户切到槽1 后编辑
  const id = pushMessage(host, {
    mes: '第一版正文', swipes: ['第一版正文', '第二版正文'], swipe_id: 1,
    variables: [
      { stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h0', ts: 1, mesId: 0 } },
      {},
    ],
  });
  const before = JSON.stringify(host.chat[id].variables[0]);
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = id;

  inst.MMS.applyModuleEdit({ name: '新据点', titleVal: '测试基地', cash: '999美元', fields: [] }, '新据点');
  await drain();

  eq('旧 swipe 槽的状态对象未被就地修改', JSON.stringify(host.chat[id].variables[0]), before);
});

// ============ R7 异步更新必须写回发起时的 swipe ============
group('R7-异步写回归属', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const prevId = pushMessage(host, {
    mes: '第一楼', variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }],
  });
  const id = pushMessage(host, {
    mes: '第二楼', swipes: ['第二楼', '第二楼改'], swipe_id: 0,
    variables: [{}, {}],
  });
  const inst = createInstance(host, { floorId: prevId, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = prevId;
  inst.MMS.messageText = '第一楼';
  inst.MMS.isLastAssistantFloor = true;

  let release;
  host.genGate = new Promise((r) => { release = r; });
  host.genHandler = () => JSON.stringify(STATE_MODULE);

  const p = inst.MMS.runUpdate(id);
  await drain();
  // 请求返回前，用户切到第二个 swipe
  host.chat[id].swipe_id = 1;
  release();
  await p;
  await drain();

  ok('写回发起时选定的 swipe 槽 0', !!host.chat[id].variables[0]?.stat_data,
    `槽0=${JSON.stringify(host.chat[id].variables[0])}`);
  ok('未写入后来切换的 swipe 槽 1', !host.chat[id].variables[1]?.stat_data,
    `槽1=${JSON.stringify(host.chat[id].variables[1])}`);
});

// ============ R7b/R7c 异步结果必须与发起时的聊天/楼层绑定 ============
group('R7b-切聊天丢弃过期结果', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const prevId = pushMessage(host, {
    mes: '第一楼', variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }],
  });
  const id = pushMessage(host, { mes: '第二楼', variables: [{}] });
  const inst = createInstance(host, { floorId: prevId, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = prevId;
  inst.MMS.messageText = '第一楼';
  inst.MMS.isLastAssistantFloor = true;

  let release;
  host.genGate = new Promise((r) => { release = r; });
  host.genHandler = () => JSON.stringify(STATE_MODULE);

  const p = inst.MMS.runUpdate(id);
  await drain();
  host.chatId = 'another-chat'; // 用户切了聊天
  release();
  await p;
  await drain();

  ok('切聊天后过期结果不写入原楼层', !host.chat[id].variables[0]?.stat_data,
    `槽0=${JSON.stringify(host.chat[id].variables[0])}`);
});

group('R7c-删楼丢弃过期结果', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const prevId = pushMessage(host, {
    mes: '第一楼', variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }],
  });
  const id = pushMessage(host, { mes: '第二楼', variables: [{}] });
  const inst = createInstance(host, { floorId: prevId, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = prevId;
  inst.MMS.messageText = '第一楼';
  inst.MMS.isLastAssistantFloor = true;

  let release;
  host.genGate = new Promise((r) => { release = r; });
  host.genHandler = () => JSON.stringify(STATE_MODULE);

  const p = inst.MMS.runUpdate(id);
  await drain();
  host.chat[id] = undefined; // 目标楼被删除
  release();
  await p;
  await drain();

  ok('删楼后过期结果不写入（楼层已不存在）', !host.chat[id], `槽=${JSON.stringify(host.chat[id])}`);
});

// ============ R6b 既有兼容路径不得被隔离修复破坏 ============
group('R6b-兼容路径保持', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const legacyText = '正文\n<Status_block>\n状态栏:\n  日期和时间: "⏰ 1925年 · 6月13日"\n  地点: "📍 悉尼 · 酒店"\n</Status_block>';
  const legacyId = pushMessage(host, { mes: legacyText });
  const id = pushMessage(host, { mes: '第二楼' });
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = id;

  const legacy = inst.MMS.readLegacyState(legacyId);
  ok('旧式 Status_block 仍可解析', !!legacy && !!legacy['状态栏'], JSON.stringify(legacy));

  const prev = await inst.MMS.findPrevState(id);
  ok('无本楼状态时仍能回溯到前楼旧格式状态', !!prev && prev.floorId === legacyId,
    JSON.stringify(prev && { f: prev.floorId }));

  const slots = inst.MMS.readFloorVarSlots(legacyId);
  ok('readFloorVarSlots 返回副本而非宿主活引用', !!slots && slots.slots !== host.chat[legacyId].variables,
    '返回了宿主 chat[].variables 本体');
});

group('R8-重算保留手改', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  const prevId = pushMessage(host, {
    mes: '第一楼', variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }],
  });
  const id = pushMessage(host, { mes: '第二楼', variables: [{}] });
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  inst.MMS.detectEnv();
  inst.MMS.floorId = id;
  inst.MMS.messageText = '第二楼';
  inst.MMS.isLastAssistantFloor = true;
  // 更新 AI 每轮把 HP 减 3（模拟真实增量命令）
  host.genHandler = () => JSON.stringify({
    状态栏: {
      日期和时间: '⏰ 1925年 · 6月13日 · 13:00',
      地点: '📍 悉尼 · 酒店',
      角色列表: [{ 角色: { 名字: '李娟', 属性: '[❤️HP-3]' } }],
    },
  });

  await inst.MMS.runUpdate(id);
  await drain();
  const afterAi = host.chat[id].variables[0].stat_data['状态栏']['角色列表'][0]['角色']['属性'];
  ok('第一次更新写入 HP 16/28', afterAi.includes('[❤️HP:16/28]'), `实际 ${afterAi}`);

  // 用户手动修正 HP 到 12
  const manual = JSON.parse(JSON.stringify(host.chat[id].variables[0].stat_data));
  manual['状态栏']['角色列表'][0]['角色']['属性'] = '[❤️HP:12/28][💧MP:3/14]';
  host.chat[id].variables[0].stat_data = manual;

  // 再次「立即更新」：不得把手改的 12 覆盖回 16
  await inst.MMS.runUpdate(id);
  await drain();
  const after2 = host.chat[id].variables[0].stat_data['状态栏']['角色列表'][0]['角色']['属性'];
  ok('同楼重算保留手动修正的 HP 12/28', after2.includes('[❤️HP:12/28]'), `实际 ${after2}`);
});

// ============ R9 物品命令必须精确匹配 ============
group('R9-物品精确匹配', async (V) => {
  const host = createHost();
  pushMessage(host, { mes: '正文' });
  const inst = createInstance(host, { floorId: 0, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  const fn = inst.sandbox.__mmsExports?.mmsApplyItemCommands;
  if (typeof fn !== 'function') {
    ok('mmsApplyItemCommands 可从沙箱取到', false, '未暴露（需在沙箱尾部导出）');
    return;
  }
  const out = fn('[高级绷带x5][绷带x2]', '[绷带-1]');
  ok('消耗命中最短同名项而非首个子串项', out.includes('[高级绷带x5]') && out.includes('[绷带x1]'), `实际 ${out}`);
  const out2 = fn('[绷带x2][高级绷带x5]', '[绷带-1]');
  ok('清单顺序调换后仍命中同一项', out2.includes('[绷带x1]') && out2.includes('[高级绷带x5]'), `实际 ${out2}`);
});

// ============ R10 换聊天后世界书注入不得残留旧聊天状态 ============
group('R10-跨聊天注入清理', async (V) => {
  const host = createHost({ chatVars: { $mms_roster: makeRoster() } });
  host.charWorldbooks = { primary: '测试世界书', additional: [] };
  host.worldbooks['测试世界书'] = [];
  const id = pushMessage(host, {
    mes: '第一楼', variables: [{ stat_data: JSON.parse(JSON.stringify(STATE_MODULE)), $mms_meta: { hash: 'h', ts: 1, mesId: 0 } }],
  });
  const inst = createInstance(host, { floorId: id, scriptText: V.scriptText, jsyamlBlock: V.jsyamlBlock });
  await inst.MMS.boot();
  await drain();
  const entry = host.worldbooks['测试世界书'].find((e) => e && e.name && e.name.includes('MMS'));
  ok('有状态聊天写入了注入条目并启用', !!entry && entry.enabled === true, JSON.stringify(entry && { n: entry.name, e: entry.enabled }));

  // 换聊天：旧 iframe 被销毁（酒馆助手清掉其监听），新聊天没有 AI 楼 → 没有新 iframe
  destroyInstance(inst);
  host.chat.length = 0;
  pushMessage(host, { mes: '' });
  await host.emit(TAVERN_EVENTS.CHAT_CHANGED, 'new-chat');
  await drain();

  const entry2 = host.worldbooks['测试世界书'].find((e) => e && e.name && e.name.includes('MMS'));
  ok('换到无状态聊天后旧注入条目被禁用', !!entry2 && entry2.enabled === false,
    JSON.stringify(entry2 && { n: entry2.name, e: entry2.enabled }));
});

// ---------------------------------------------------------------- 运行
function parseArgs() {
  const out = { src: 'all', only: null };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--src=')) out.src = a.slice(6);
    if (a.startsWith('--only=')) out.only = a.slice(7);
  }
  return out;
}

async function main() {
  const args = parseArgs();
  const sources = SOURCES.filter((s) => args.src === 'all' || s.key === args.src);
  const groups = GROUPS.filter((g) => !args.only || g.name.startsWith(args.only));
  console.log('====================================================');
  console.log('  MiniMapStatus 运行期回归（真实方法 / 离线沙箱）');
  console.log('====================================================');

  for (const S of sources) {
    const V = loadVersion(S);
    // 沙箱尾部导出纯函数（供 R9 之类直接调用）
    V.scriptText += '\n;globalThis.__mmsExports = { mmsApplyItemCommands, mmsApplyAttrCommands, mmsCashCompute, mmsPickFloorVarSlot, mmsMatchOne, mmsMergeState };';
    console.log(`\n--- ${S.label}（${S.html}）---`);
    for (const g of groups) {
      console.log(`\n[${g.name}]`);
      try {
        await g.fn(V);
      } catch (e) {
        failures.push(`${g.name} 抛异常`);
        console.log(`  [FAIL] ${g.name} 抛异常: ${e && e.message ? e.message : e}`);
        if (e && e.stack) console.log(String(e.stack).split('\n').slice(1, 5).join('\n'));
      }
    }
  }

  console.log('\n====================================================');
  if (failures.length) {
    console.log(`  失败 ${failures.length} 项 / 通过 ${passCount} 项`);
    for (const f of failures) console.log(`   · ${f}`);
    console.log('====================================================');
    process.exitCode = 1;
  } else {
    console.log(`  全部断言通过！共 ${passCount} 项`);
    console.log('====================================================');
  }
}

// 直接运行时才跑；被 import 时只导出夹具（便于单独调试某个场景）
export { createHost, createInstance, pushMessage, loadVersion, SOURCES, makeRoster, STATE_MODULE, BILL, drain, destroyInstance };

main().catch((e) => {
  console.error('[test-runtime] 运行失败:', e);
  process.exitCode = 1;
});
