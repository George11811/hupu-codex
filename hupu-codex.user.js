// ==UserScript==
// @name         虎扑社区 · Codex 外观
// @namespace    https://bbs.hupu.com/
// @version      1.1.0
// @description  把虎扑社区（bbs.hupu.com）换成 Codex 桌面 app 风格：左 rail + 主区 + 右侧代码面板 + 应急伪装。只改外观，不改动站点数据。
// @author       link
// @match        https://bbs.hupu.com/*
// @icon         https://w1.hoopchina.com.cn/images/pc/old/favicon.ico
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * ── 与原脚本（v2ex 版）的核心差异 ───────────────────────────────────────────
 *
 * 1. 数据来源完全不同，而且比 v2ex 好得多。
 *    v2ex 是纯服务端渲染的 MPA、没有 JSON 端点，只能解析已渲染的 DOM。
 *    虎扑是两套前端：
 *      · 版块页 / 首页 / 分类页 → React 服务端渲染，整页数据内嵌在 window.$$data 里
 *      · 帖子详情页              → Next.js，整页数据内嵌在 <script id="__NEXT_DATA__">
 *    两者都是「一次性内嵌完整 JSON」，所以本脚本**优先读 JSON**，
 *    拿到的字段（亮数、回复数、浏览数、楼层、引用关系、发布时间戳）比 DOM 全得多，
 *    也不怕 CSS-module 的哈希类名（index_xxx__PC7_r 这种）跟着发版变。
 *    DOM 解析只作为兜底：JSON 取不到时才走。
 *
 * 2. 详情页楼层分页规则不同：虎扑 20 楼/页，URL 是 /<tid>-<page>.html，
 *    第 1 页是 /<tid>.html（没有 -1）；版块页翻页是 <baseUrl>-<page>，
 *    而 baseUrl 本身就带 -postdate / -hot 后缀 —— 写成 /topic-daily-2-postdate
 *    会静默返回首页数据（HTTP 依然 200），这点很容易踩，详见 listPageUrl 的注释。
 *
 * 3. 虎扑的「亮评」是个独立区块（原生的 .post-reply-list 第一组），
 *    和普通回复不是一回事，所以单独渲染成一组。
 *
 * 4. 发帖 / 回帖必须登录，而脚本不碰登录态。所以底部的 composer 不假装能发送：
 *    它是一个「本地草稿板」（按帖子 id 存 localStorage）+ markdown 预览 +
 *    一键复制 + 跳原生回复框。点楼层的「回复」会把引用和 @ 写进草稿。
 *
 * 5. 原生根节点 id 有两套（列表页 #container、详情页 #__next），接管时要一起隐藏。
 *
 * 6. 站内链接走「软导航」：fetch 回目标页 HTML、解析出数据后在同一个文档里重画，
 *    浏览器不换文档 —— 所以切版块 / 进帖子 / 翻页不会再闪一下虎扑原生页面。
 *    （虎扑是多文档站点，整页跳转时新文档从创建到第一次绘制可能只要 ~30ms，
 *    早于油猴注入，这个窗口在页面里压不掉。）详见「软导航」一节。
 * ────────────────────────────────────────────────────────────────────────────
 */

(function () {
  "use strict";

  /* ============================== 设置 ==============================
   *
   * 所有可调项都在 DEFAULTS 里；用户改过的统一存成一个 JSON
   * （localStorage 的 hpcx:settings），读走 cfg()、写走 setCfg()。
   * ============================================================== */

  const DEFAULTS = {
    /* —— 外观 —— */
    /** "auto" 跟随系统 | "dark" | "light" */
    theme: "auto",
    /** 左 rail 宽度 */
    railWidth: 300,
    /** 右侧代码面板宽度 */
    panelWidth: 440,
    /** 正文最大宽度 */
    threadMaxWidth: 860,
    /** 是否显示右侧代码面板（纯氛围装饰） */
    codePanel: true,
    /** 代码面板语言：rust / python / typescript / go / java */
    lang: "rust",
    /** 代码面板视图："code" | "diff" */
    codeMode: "code",

    /* —— 伪装 —— */
    /**
     * 摸鱼模式：
     *   - 左栏品牌名 → "Codex"（brandName 留空时）
     *   - 标签页标题 → 源码文件名（不再出现「虎扑」「步行街」字样）
     *   - 启用应急伪装键
     */
    stealth: true,
    /**
     * 应急伪装键：按下后整个视口变成「代码编辑器 + 构建日志」，再按一次恢复。
     *   "esc2"          连按两下 Esc（默认）
     *   "f2"            单键
     *   "ctrl+shift+h"  组合键
     * 无论配成什么，Ctrl+Shift+H 始终有效。
     */
    stealthKey: "esc2",
    /** 左栏品牌名。空字符串 = 由 stealth 决定（Codex / 虎扑社区） */
    brandName: "",
    /** 代码面板 / 面包屑 / 标签页标题里的项目名 */
    projectName: "platform",
    /** favicon："codex" = Codex 风格圆角图标 | "site" = 保留虎扑原图标 */
    favicon: "codex",

    /* —— agent 装饰（内容全是假的，纯装饰）—— */
    /** 总开关：思考块 + 工具调用行 */
    decorations: true,
    /** 列表里穿插痕迹的比例（%）。0 = 列表里不插 */
    listTraceRate: 46,
    /** 列表里的思考块是否默认展开 */
    listThinkingOpen: false,
    /** 详情页的思考块是否默认展开 */
    detailThinkingOpen: true,

    /* —— 引用卡片（虎扑原生 quote 字段）—— */
    /** 把回复引用的上一层渲染成可折叠卡片 */
    quoteCard: true,
    /** 引用卡片正文默认展开 */
    quoteOpen: true,

    /* —— 亮评（被点亮最多的回复，虎扑单独一组）—— */
    /** 是否单独渲染「亮评」区块（关掉就混在普通回复里） */
    showLights: true,
    /** 亮评区默认折叠 */
    lightsCollapsed: false,
    /** 亮评区底色。"" = 无底色；其余为 #rrggbb */
    lightsBg: "#f0d1c6",
    /** 底色浓度（%）。用半透明混色，这样任意颜色在明暗两种主题下都不至于看不清字 */
    lightsTint: 12,

    /* —— 正文图片 —— */
    /** 缩略图尺寸上限 */
    thumbWidth: 300,
    thumbHeight: 200,
    /** 鼠标悬停时浮出大图预览 */
    thumbPreview: true
  };

  const SETTINGS_KEY = "hpcx:settings";
  const DRAFT_PREFIX = "hpcx:draft:";

  let SETTINGS = null;

  function loadSettings() {
    const out = Object.assign({}, DEFAULTS);
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        for (const k of Object.keys(DEFAULTS)) {
          // 类型不符就忽略，避免手工改坏 localStorage 后整个面板崩掉
          if (obj[k] !== undefined && typeof obj[k] === typeof DEFAULTS[k]) out[k] = obj[k];
        }
      }
    } catch { /* 坏了就用默认值 */ }
    return out;
  }

  function cfg(key) {
    if (!SETTINGS) SETTINGS = loadSettings();
    return SETTINGS[key] !== undefined ? SETTINGS[key] : DEFAULTS[key];
  }

  /** 写设置。visualOnly = 只刷新 CSS 变量，不重渲染（拖滑块时用） */
  function setCfg(key, value, opts) {
    if (!SETTINGS) SETTINGS = loadSettings();
    SETTINGS[key] = value;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch { /* 隐私模式等 */ }
    if (opts && opts.visualOnly) applyVisualSettings();
    else applySettings();
  }

  function resetSettings() {
    SETTINGS = Object.assign({}, DEFAULTS);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(SETTINGS)); } catch { /* ignore */ }
    applySettings();
  }

  function brandName() {
    const custom = cfg("brandName");
    return custom || (cfg("stealth") ? "Codex" : "虎扑社区");
  }

  /**
   * 只改 CSS 变量 / class —— 不重渲染。
   * 拖宽度滑块走这条，否则每动一格都重排整个列表会很卡。
   */
  function applyVisualSettings() {
    const root = document.documentElement;
    root.style.setProperty("--cx-rail-w", cfg("railWidth") + "px");
    root.style.setProperty("--hpcx-panel-w", cfg("panelWidth") + "px");
    root.style.setProperty("--hpcx-thread-max", cfg("threadMaxWidth") + "px");
    root.style.setProperty("--hpcx-thumb-w", cfg("thumbWidth") + "px");
    root.style.setProperty("--hpcx-thumb-h", cfg("thumbHeight") + "px");
    applyLightsTint();
    syncMode();
    applyFavicon();
    syncTitle();
    setPanelHidden(!cfg("codePanel"), false);
  }

  /**
   * 亮评区的底色靠三个 CSS 变量驱动：
   *   --hpcx-lights-bg     用户选的颜色（无底色时给 transparent）
   *   --hpcx-lights-tint   混色比例，0% 就等于没有底色
   *   --hpcx-lights-edge   边框 / 计数胶囊用的浓度
   *
   * 用 color-mix 半透明混色而不是直接刷一层实色：实色在深色主题下
   * 很容易变成一大块刺眼的亮斑，而且正文对比度不可控。
   *
   * 拆成 paint / apply 两层是为了让设置面板拖滑块时能即时预览。
   */
  function paintLightsTint(color, tint) {
    const el = document.documentElement;
    const c = String(color == null ? "" : color).trim();
    const has = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c);
    const t = has ? Math.max(0, Math.min(60, Number(tint) || 0)) : 0;
    el.style.setProperty("--hpcx-lights-bg", has ? c : "transparent");
    el.style.setProperty("--hpcx-lights-tint", t + "%");
    el.style.setProperty("--hpcx-lights-edge", Math.min(70, Math.round(t * 2.4)) + "%");
  }

  function applyLightsTint() {
    paintLightsTint(cfg("lightsBg"), cfg("lightsTint"));
  }

  function applySettings() {
    applyVisualSettings();
    renderCodePanel();
    render();
    if (bossOn()) renderBoss();
  }

  /* ============================== 常量 ============================== */

  const STYLE_ID = "hupu-codex-theme";
  const FAVICON_ID = "hupu-codex-favicon";
  const ROOT_CLASS = "hpcx";          // <html> 上的激活标记
  const LIGHT_CLASS = "hpcx-light";   // 浅色模式
  const LOCK_CLASS = "hpcx-locked";   // 隐藏原生页面
  const BOOT_CLASS = "hpcx-boot";     // 启动中：先盖住原生页面，但还没判定路由
  const BOSS_CLASS = "hpcx-boss-on";  // 应急伪装视图

  const RAIL_W = DEFAULTS.railWidth;
  const PANEL_DEFAULT_W = DEFAULTS.panelWidth;

  /** 虎扑楼层分页：20 楼 / 页（和 v2ex 的 100 完全不同） */
  const REPLIES_PER_PAGE = 20;

  const HOME = "https://bbs.hupu.com";
  const LOGIN_URL = "https://passport.hupu.com/pc/login";

  /** rail 顶部常用专区（可按喜好增删） */
  const QUICK_TOPICS = [
    { name: "步行街主干道", url: "/topic-daily" },
    { name: "恋爱区", url: "/love" },
    { name: "篮球场", url: "/nba" },
    { name: "湿乎乎的话题", url: "/vote" },
    { name: "英雄联盟", url: "/lol" },
    { name: "影视区", url: "/ent" },
    { name: "数码综合讨论", url: "/digital" },
    { name: "历史区", url: "/history" },
    { name: "汽车区", url: "/cars" },
    { name: "绝地求生", url: "/pubg" }
  ];

  /* ============================== 内联 SVG 图标 ============================== */

  const ICONS = {
    sidebar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9.5" y1="4" x2="9.5" y2="20"/></svg>`,
    chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 9 12 14 17 9"/></svg>`,
    chevronRightSm: `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>`,
    search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
    refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.2-6.9"/><polyline points="21 3 21 9 15 9"/></svg>`,
    layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>`,
    clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>`,
    fire: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s5 5 5 9a5 5 0 0 1-10 0c0-1.5.7-2.8 1.5-3.8C8 9 9 9.5 9 8c0-2 3-6 3-6Z"/><path d="M12 22a5 5 0 0 0 5-5c0-3-2-5-5-8-3 3-5 5-5 8a5 5 0 0 0 5 5Z"/></svg>`,
    home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/></svg>`,
    gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.01a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1Z"/></svg>`,
    folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>`,
    folderOpen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
    external: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>`,
    dots: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>`,
    terminal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><polyline points="7 9 10 12 7 15"/><path d="M12.5 15H17"/></svg>`,
    globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.7 2.6 4 5.7 4 9s-1.3 6.4-4 9c-2.7-2.6-4-5.7-4-9s1.3-6.4 4-9Z"/></svg>`,
    user: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="7.5" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/></svg>`,
    tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05 12.35 2a1.4 1.4 0 0 0-1-.4H3a1 1 0 0 0-1 1v8.35a1.4 1.4 0 0 0 .4 1l9.1 9.05a1.4 1.4 0 0 0 2 0l7.9-7.9a1.4 1.4 0 0 0 0-2Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>`,
    reply: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
    menu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`,
    panel: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="3"/><line x1="14.5" y1="4" x2="14.5" y2="20"/></svg>`,
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/></svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3v5h5"/><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a7.5 7.5 0 1 0 11 11Z"/></svg>`,
    filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v5.5L10 21v-8Z"/></svg>`,
    link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
    branch: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6.5" cy="6" r="2.4"/><circle cx="6.5" cy="18" r="2.4"/><circle cx="17.5" cy="8.5" r="2.4"/><path d="M6.5 8.4v7.2"/><path d="M17.5 10.9c0 3.4-3.6 3.3-6.3 4.1"/></svg>`,
    quote: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.6 6.2C6.6 7.6 5 10 5 13.3V18h5.3v-5.3H7.9c0-2 .9-3.4 2.7-4.3L9.6 6.2Zm9 0C15.6 7.6 14 10 14 13.3V18h5.3v-5.3h-2.4c0-2 .9-3.4 2.7-4.3L18.6 6.2Z"/></svg>`,
    sparkle: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.2l1.9 5.6 5.6 1.9-5.6 1.9L12 17.2l-1.9-5.6L4.5 9.7l5.6-1.9L12 2.2Z"/><path d="M18.4 15.6l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z"/><path d="M5.6 14.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9Z"/></svg>`,
    heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 5.6a5.4 5.4 0 0 0-7.7 0L12 6.7l-1.1-1.1a5.4 5.4 0 0 0-7.7 7.7l1.1 1.1L12 21.6l7.7-7.7 1.1-1.1a5.4 5.4 0 0 0 0-7.7Z"/></svg>`,
    bulb: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7V18h8v-3.3A7 7 0 0 0 12 2Z"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
    bold: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h7a4 4 0 0 1 0 8H6z"/><path d="M6 12h8a4 4 0 0 1 0 8H6z"/></svg>`,
    italic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>`,
    list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>`,
    play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`
  };

  function ic(name) {
    return ICONS[name] || "";
  }

  /* ============================== favicon（Codex 风：圆角深底 + 花） ============================== */

  // Codex / OpenAI 花朵 path（simple-icons openai, CC0）
  const CX_OPENAI_PATH =
    "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

  let faviconUriCache = null;
  let faviconModeCache = null;

  function makeFaviconUri() {
    if (cfg("favicon") === "site") return null;
    const light = !isDarkMode();
    const mode = light ? "light" : "dark";
    if (faviconUriCache && faviconModeCache === mode) return faviconUriCache;
    const bg = light ? "#f2f2f3" : "#171717";
    const fg = light ? "#0f0f0f" : "#ffffff";
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<rect width="24" height="24" rx="5.5" fill="' + bg + '"/>' +
      '<path fill="' + fg + '" d="' + CX_OPENAI_PATH + '"/></svg>';
    faviconUriCache = "data:image/svg+xml," + encodeURIComponent(svg);
    faviconModeCache = mode;
    return faviconUriCache;
  }

  /* ============================== 工具函数 ============================== */

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function txt(el) {
    return el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  function attr(el, name) {
    return el ? String(el.getAttribute(name) || "") : "";
  }

  /**
   * 从脏字符串里取数字。
   *
   * 只取**第一段**连续数字（允许千分位逗号），而不是把整串数字粘起来：
   *   "655 / 24618" → 655      （列表页的「回复/浏览」就是这种形状）
   *   "1,234"       → 1234
   *   "亮12"         → 12
   * 早前的实现是 replace(/[^\d-]/g,"")，遇到 "655 / 24618" 会得到 65524618。
   * 当前调用点都先切分过，所以没出血，但这是个随时会咬人的坑，先堵上。
   */
  function num(s) {
    const m = String(s == null ? "" : s).match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!m) return 0;
    const n = parseInt(m[0].replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** 把 1789290610000 这种毫秒戳 / "09-15 11:02" 这种短时间，统一成可读中文时间 */
  function formatTime(v) {
    if (v == null || v === "") return "";
    let d;
    if (typeof v === "number" || /^\d{10,13}$/.test(String(v))) {
      let n = Number(v);
      if (n < 1e11) n *= 1000; // 秒 → 毫秒
      d = new Date(n);
    } else {
      const s = String(v);
      // 纯 "09-15 11:02" 没有年份，补当前年
      const m = s.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
      if (m) d = new Date(new Date().getFullYear() + "-" + m[1] + "-" + m[2] + "T" + m[3] + ":" + m[4]);
      else d = new Date(s.replace(" ", "T"));
    }
    if (!d || isNaN(d.getTime())) return String(v);

    const now = Date.now();
    const diff = now - d.getTime();
    const min = 60000, hour = 60 * min, day = 24 * hour;
    if (diff >= -60000 && diff < min) return "刚刚";
    if (diff >= 0 && diff < hour) return Math.floor(diff / min) + " 分钟前";
    if (diff >= 0 && diff < day) return Math.floor(diff / hour) + " 小时前";
    if (diff >= 0 && diff < 30 * day) return Math.floor(diff / day) + " 天前";

    const p = (n) => String(n).padStart(2, "0");
    const sameYear = d.getFullYear() === new Date().getFullYear();
    const date = sameYear
      ? p(d.getMonth() + 1) + "-" + p(d.getDate())
      : d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
    return date + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** 稳定伪随机（同一 seed 永远同一串数） */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function domReady() {
    if (document.readyState === "loading") {
      return new Promise((r) => document.addEventListener("DOMContentLoaded", r, { once: true }));
    }
    return Promise.resolve();
  }

  function copyText(text) {
    const s = String(text == null ? "" : text);
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = s;
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        ta.setAttribute("data-hpcx", "");
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        toastNow("已复制");
      } catch {
        toastNow("复制失败，请手动选择文本");
      }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(() => toastNow("已复制"), fallback);
    } else fallback();
  }

  let toastTimer = null;
  function toastNow(msg) {
    let box = document.querySelector(".hpcx-toast");
    if (!box) {
      box = document.createElement("div");
      box.className = "hpcx-toast";
      box.setAttribute("data-hpcx", "");
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove("on"), 1900);
  }

  /* ============================== 读取页面内嵌数据 ==============================
   *
   * 虎扑两个前端都把整页数据内嵌在 <script> 里：
   *   · 列表/首页/分类：window.$$data = {...}
   *   · 帖子详情：      <script id="__NEXT_DATA__" type="application/json">
   * 优先用它们；只有取不到时才退回解析 DOM。
   * ================================================================ */

  /**
   * 从 `text` 里切出第一个完整的 JSON 对象。
   * 不能直接 indexOf("</script>") ——数据里可能出现这个字符串，
   * 所以老老实实做一次带字符串状态的括号配平扫描。
   */
  function extractJsonObject(text) {
    const start = String(text || "").indexOf("{");
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  /*
   * SRC = 「当前展示页面」对应的文档。
   *
   * 正常情况就是 document；做软导航（见「软导航」一节）时会被换成 fetch 回来、
   * 用 DOMParser 解析出的那份 —— 数据读取与 DOM 兜底都从它取，界面照旧画在真实
   * document 上。这样软导航不用改任何解析函数的签名。
   */
  let SRC = document;

  /** 在页面内联脚本里找 `<marker>{...}` 并解析（marker 例如 "window.$$data="） */
  function readInlineJson(marker) {
    const scripts = SRC.querySelectorAll("script:not([src])");
    for (const s of scripts) {
      const t = s.textContent || "";
      if (t.indexOf(marker) < 0) continue;
      const raw = extractJsonObject(t.slice(t.indexOf(marker) + marker.length));
      if (!raw) continue;
      try { return JSON.parse(raw); } catch { /* 换下一个 script */ }
    }
    return null;
  }

  let DATA_CACHE = null;
  /** 什么都没读到时返回的共享空对象（不会进缓存） */
  const NO_DATA = { sdata: null, next: null };

  function pageData() {
    if (DATA_CACHE) return DATA_CACHE;

    // 1) window.$$data（React 列表页）—— 优先读全局，读不到再读内联脚本文本。
    //    软导航时 SRC 是一份游离文档，没有 window，只能读内联 JSON
    let sdata = null;
    if (SRC === document) {
      try {
        if (window.$$data && typeof window.$$data === "object") sdata = window.$$data;
      } catch { /* ignore */ }
    }
    if (!sdata) sdata = readInlineJson("window.$$data=");

    // 2) #__NEXT_DATA__（Next.js 详情页）
    let next = null;
    const nx = SRC.getElementById("__NEXT_DATA__");
    if (nx) {
      try { next = JSON.parse(nx.textContent || "{}"); } catch { next = null; }
    }
    if (!next) {
      const alt = readInlineJson('"pageProps"');
      if (alt) next = { props: { pageProps: alt } };
    }

    /*
     * 关键：什么都没读到就**绝对不要缓存**。
     *
     * bootstrap 在 document-start 就会跑一次，那时 <body> 还没解析，
     * 而虎扑把整页数据放在 **body 末尾**的 <script> 里（$$data / __NEXT_DATA__），
     * 要几百毫秒后才存在。一旦把这次的空结果缓存下来，之后所有调用都拿空数据，
     * 版块页就会被判定成「不支持的路由」→ 原生样式一直露着，
     * 直到兜底定时器清缓存为止 —— 这就是「初次打开闪一下虎扑原网页」的真正原因。
     *
     * 现在：空结果不缓存，下次调用自动重读；真读到了才缓存。
     */
    if (!sdata && !next) return NO_DATA;

    DATA_CACHE = { sdata, next };
    return DATA_CACHE;
  }

  /** Next.js 详情页的 pageProps.detail */
  function nextDetail() {
    const { next } = pageData();
    const p = next && next.props && next.props.pageProps;
    return p && p.detail ? p.detail : null;
  }

  /* ============================== 路由判定 ============================== */

  /**
   * 路由只有三类：
   *   thread —— /<tid>.html 或 /<tid>-<page>.html
   *   list   —— 版块页（$$data.topic.threads）或 首页/分类页（$$data.pageData）
   *   other  —— 其余（搜索、登录、跳转页…），只加 rail，不接管主区
   */
  function route() {
    const p = location.pathname;
    let m;

    if ((m = p.match(/^\/(\d+)(?:-(\d+))?\.html$/))) {
      return { kind: "thread", tid: m[1], page: Number(m[2] || 1) || 1, path: p };
    }

    const { sdata } = pageData();
    const t = sdata && sdata.topic;
    if (t && t.threads && Array.isArray(t.threads.list)) {
      return {
        kind: "list",
        listKind: "topic",
        // baseUrl 已含排序后缀（-postdate / -hot），翻页就是 base + "-" + page
        base: t.threads.baseUrl || (t.topic && t.topic.url) || p,
        page: Number(t.page || t.threads.current || 1) || 1,
        topic: t.topic || null,
        path: p
      };
    }
    const pd = sdata && sdata.pageData;
    if (pd) {
      const cate = pd.category || {};
      return {
        kind: "list",
        listKind: String(cate.cateId || "0") === "0" ? "home" : "category",
        category: cate,
        path: p
      };
    }
    return { kind: "other", path: p };
  }

  function isSupported(r) {
    return r.kind === "thread" || r.kind === "list";
  }

  /* ============================== 版块页分页 URL ==============================
   *
   * 实测结论（踩过的坑，记在这里免得以后再猜）：
   *
   *   1. $$data.topic.threads.baseUrl **已经带上排序后缀**：
   *        /topic-daily            /topic-daily-postdate       /topic-daily-hot
   *      所以翻页就是 baseUrl + "-" + page，
   *        /topic-daily-2  /topic-daily-postdate-2  /topic-daily-hot-2
   *
   *   2. 「后缀在页码后面」是**错的**：
   *        /topic-daily-2-postdate  → 静默回退到首页数据（pageData，cateId=0）
   *        /topic-daily-2-hot       → 同上
   *      两个都返回 HTTP 200，但拿到的根本不是那个版块的第 2 页，
   *      所以不能靠状态码判断，只能读数据里的 sort/current 验证。
   *
   *   3. $$data.topic.sort 是服务端给的权威排序 id（2 最新回复 / 1 最新发布 / 4 24小时榜），
   *      比自己从 URL 反推靠谱（URL 写错了它也能告诉你真实排序）。
   * ====================================================================== */

  /** 虎扑 $$data.topic.tabs 的 id：2 = 最新回复，1 = 最新发布，4 = 24小时榜 */
  const SORT_LABEL = { "2": "最新回复", "1": "最新发布", "4": "24小时榜" };

  function listPageUrl(base, page) {
    const b = String(base || "");
    return page > 1 ? b + "-" + page : b;
  }

  function threadPageUrl(tid, page) {
    return page > 1 ? "/" + tid + "-" + page + ".html" : "/" + tid + ".html";
  }

  /* ============================== 数据规范化 ==============================
   *
   * 把三种来源（列表 JSON / 详情 JSON / DOM 兜底）统一成同一组结构，
   * 渲染层只认这几个函数，不再关心数据从哪来。
   * ==================================================================== */

  /** 列表行：{ tid, title, url, replies, lights, read, timeText, timeMs, author, topic } */
  function normRow(x) {
    if (!x) return null;
    const tid = String(x.tid || x.threadId || "");
    if (!tid) return null;
    const topic = x.topic || x.forum || null;
    const author = x.author || null;
    return {
      tid,
      title: String(x.title || ""),
      url: x.url || ("/" + tid + ".html"),
      cover: x.cover || "",
      desc: x.desc || "",
      replies: num(x.replies),
      lights: num(x.lights != null ? x.lights : x.lightReply),
      read: num(x.read),
      timeText: String(x.createdAtFormat || x.repliedAtFormat || x.time || ""),
      timeMs: Number(x.repliedAt || x.createdAt || 0) || 0,
      author: author
        ? { name: String(author.puname || author.userName || ""), url: author.url || "" }
        : (x.userName ? { name: String(x.userName), url: "" } : null),
      topic: topic && (topic.name || topic.topicId)
        ? { name: String(topic.name || ""), url: String(topic.url || (topic.topicId ? "/" + topic.topicId : "")) }
        : null
    };
  }

  /** 回复/楼层：统一成 turn */
  function normTurn(x, floor, isOp) {
    if (!x) return null;
    const a = x.author || {};
    const q = x.quote || null;
    const qa = q && (q.author || {});
    const pid = String(x.pid || "");
    return {
      pid,
      floor: String(floor),
      // 装饰种子：回复用 pid（稳定且唯一），没 pid 才退回楼层号。
      // 亮评和普通回复可能指向同一条内容，所以不能都用楼层号做种子。
      seed: pid || String(floor),
      author: {
        name: String(a.puname || x.userName || ""),
        url: String(a.url || ""),
        header: String(a.header || ""),
        level: num(a.level)
      },
      timeText: String(x.createdAtFormat || ""),
      timeMs: Number(x.createdAt || 0) || 0,
      contentHtml: String(x.content || ""),
      lights: num(x.allLightCount != null ? x.allLightCount : x.count),
      lightsRaw: num(x.count),
      location: String(x.location || ""),
      client: String(x.client || ""),
      replyNum: num(x.replyNum),
      isOp: !!isOp,
      /** 点亮状态：数据里有时才可靠（未登录的响应里没有这个字段） */
      isLighted: x.isLighted === true,
      quote: q && (q.content || qa.puname)
        ? {
          pid: String(q.pid || ""),
          authorName: String(qa.puname || ""),
          authorUrl: String(qa.url || ""),
          contentHtml: String(q.content || ""),
          lights: num(q.allLightCount != null ? q.allLightCount : q.count)
        }
        : null
    };
  }

  /** 详情页：从 __NEXT_DATA__ 组装 */
  function threadData() {
    const d = nextDetail();
    const r = route();
    if (!d || !d.thread) return null;

    const th = d.thread;
    const rep = d.replies || {};
    const page = Number(rep.current || r.page || 1) || 1;
    const size = Number(rep.size || REPLIES_PER_PAGE) || REPLIES_PER_PAGE;
    const total = Number(rep.total || 1) || 1;
    const base = (page - 1) * size;

    const lights = (d.lights || []).map((x, i) => normTurn(x, "亮" + (i + 1), false)).filter(Boolean);
    const turns = (rep.list || []).map((x, i) => normTurn(x, base + i + 1, false)).filter(Boolean);

    return {
      kind: "thread",
      tid: String(th.tid || r.tid),
      title: String(th.title || ""),
      contentHtml: String(th.content || ""),
      hasContent: !!String(th.content || "").replace(/<[^>]*>/g, "").trim() || /<img/i.test(String(th.content || "")),
      author: {
        name: String((th.author && th.author.puname) || ""),
        url: String((th.author && th.author.url) || ""),
        header: String((th.author && th.author.header) || ""),
        level: num(th.author && th.author.level)
      },
      timeMs: Number(th.createdAt || 0) || 0,
      timeText: String(th.createdAtFormat || ""),
      replies: num(th.replies),
      lights: num(th.lights),
      recommend: num(th.recommend),
      read: num(th.read),
      location: String(th.location || ""),
      // 发回帖 / 发帖接口要用（POST /pcmapi/pc/bbs/v1/...）
      fid: String(th.fid || (th.topic && th.topic.fid) || ""),
      topicId: String(th.topicId || ""),
      cateId: String((th.topic && th.topic.cateId) || ""),
      /** 当前登录用户的 puid（未登录是 "0"）—— 点亮接口要带它 */
      myPuid: String((d.user && d.user.puid) || ""),
      topic: th.topic ? { name: String(th.topic.name || ""), url: String(th.topic.url || "") } : null,
      breadCrumb: Array.isArray(d.breadCrumb) ? d.breadCrumb : [],
      page, size, totalPages: total,
      lightsList: lights,
      turns,
      sidebarHot: (d.hot || []).map(normRow).filter(Boolean),
      sidebarLatest: (d.latest || []).map(normRow).filter(Boolean)
    };
  }

  /** 列表页：从 $$data 组装 */
  function listData() {
    const r = route();
    const { sdata } = pageData();
    if (!sdata || !r || r.kind !== "list") return null;

    if (r.listKind === "topic") {
      const t = sdata.topic || {};
      const th = t.threads || {};
      const rows = (th.list || []).map(normRow).filter(Boolean);
      return {
        kind: "list",
        listKind: "topic",
        title: (t.topic && t.topic.name) || "版块",
        desc: (t.topic && t.topic.desc) || "",
        countText: (t.topic && t.topic.countText) || "",
        // baseUrl 已含排序后缀，翻页直接接 -page
        base: th.baseUrl || (t.topic && t.topic.url) || r.base || r.path,
        // 当前专区本身的 URL（不含排序/页码），用来在 rail 里判断高亮
        topicUrl: (t.topic && t.topic.url) || "",
        // 发新帖要用：topicId / cateId / fid 都在 topic 对象里
        board: t.topic
          ? {
            name: String(t.topic.name || ""),
            topicId: String(t.topic.topicId || ""),
            cateId: String(t.topic.cateId || ""),
            fid: String(t.topic.fid || ""),
            url: String(t.topic.url || "")
          }
          : null,
        page: Number(th.current || r.page || 1) || 1,
        totalPages: Number(th.total || 1) || 1,
        sort: SORT_LABEL[String(t.sort)] ? String(t.sort) : "2",
        tabs: Array.isArray(t.tabs) ? t.tabs : [],
        rows,
        breadCrumb: Array.isArray(t.breadCrumb) ? t.breadCrumb : [],
        categories: Array.isArray(t.categories) ? t.categories : [],
        hot: Array.isArray(t.hot) ? t.hot : [],
        trending: [],
        careList: [],
        author: null
      };
    }

    const pd = sdata.pageData || {};
    const cate = pd.category || {};
    return {
      kind: "list",
      listKind: r.listKind,
      title: cate.name || "虎扑社区",
      desc: r.listKind === "home" ? "全站最新推荐" : (cate.name || "") + " 版块聚合",
      countText: String(cate.topicCount || ""),
      base: cate.url || "/",
      topicUrl: cate.url || "",
      page: 1,
      totalPages: 1,
      sort: "2",
      tabs: [],
      rows: (pd.threads || []).map(normRow).filter(Boolean),
      breadCrumb: [],
      categories: Array.isArray(pd.categories) ? pd.categories : [],
      hot: Array.isArray(pd.hot) ? pd.hot : [],
      trending: Array.isArray(pd.trending) ? pd.trending : [],
      careList: Array.isArray(sdata.careListInfo) ? sdata.careListInfo : [],
      author: null
    };
  }

  /* ---------- DOM 兜底（JSON 取不到时才用） ---------- */

  const domParse = {};

  domParse.listRows = function (root) {
    const out = [];
    const seen = new Set();
    root.querySelectorAll("li.bbs-sl-web-post-body, li[class*='post-body']").forEach((li) => {
      const a = li.querySelector("a.p-title, .post-title a");
      if (!a) return;
      const m = attr(a, "href").match(/\/(\d+)(?:-\d+)?\.html/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const datum = li.querySelector(".post-datum");
      const counts = txt(datum).split("/");
      out.push(normRow({
        tid: m[1],
        title: txt(a),
        url: "/" + m[1] + ".html",
        replies: counts[0],
        read: counts[1],
        author: { puname: txt(li.querySelector(".post-auth a")), url: attr(li.querySelector(".post-auth a"), "href") },
        createdAtFormat: txt(li.querySelector(".post-time"))
      }));
    });
    return out.filter(Boolean);
  };

  domParse.thread = function (root) {
    const r = route();
    if (r.kind !== "thread") return null;
    const titleEl = root.querySelector("h1[class*='name'], .index_name__M5qqs");
    const opEl = root.querySelector(".post-content_main-post-info .thread-content-detail")
      || root.querySelector(".bbs-post-content .thread-content-detail")
      || root.querySelector(".thread-content-detail");
    const turns = [];
    root.querySelectorAll(".post-reply-list-container").forEach((box) => {
      const content = box.querySelector(".m-c .thread-content-detail") || box.querySelector(".thread-content-detail");
      if (!content) return;
      const nameA = box.querySelector(".post-reply-list-user-info-top-name");
      const quote = box.querySelector(".quote-thread .index_quote-text__HggrH");
      turns.push(normTurn({
        content: content.innerHTML,
        author: { puname: txt(nameA), url: attr(nameA, "href") },
        createdAtFormat: txt(box.querySelector(".post-reply-list-user-info-top-time")),
        location: txt(box.querySelector(".post-reply-list-user-info-user-location")).replace(/^发布于/, ""),
        quote: quote ? { content: (box.querySelector(".index_simple-detail-content__3FPFA") || {}).innerHTML || "", author: { puname: "" } } : null
      }, turns.length + 1, false));
    });
    return {
      kind: "thread",
      tid: r.tid,
      title: txt(titleEl),
      contentHtml: opEl ? opEl.innerHTML : "",
      hasContent: !!(opEl && opEl.innerHTML.replace(/<[^>]*>/g, "").trim()),
      author: { name: "", url: "", header: "", level: 0 },
      timeMs: 0, timeText: "",
      replies: turns.length, lights: 0, recommend: 0, read: 0, location: "",
      topic: null, breadCrumb: [],
      page: r.page, size: REPLIES_PER_PAGE, totalPages: 1,
      lightsList: [], turns,
      sidebarHot: [], sidebarLatest: []
    };
  };

  /** 统一入口：优先 JSON，取不到退 DOM */
  function collectPage() {
    const r = route();
    let data = null;
    if (r.kind === "thread") data = threadData();
    else if (r.kind === "list") data = listData();

    if (!data && isSupported(r)) {
      try {
        data = r.kind === "thread" ? domParse.thread(SRC) : {
          kind: "list", listKind: r.listKind, title: SRC.title,
          desc: "", countText: "", base: r.base || "/",
          page: 1, totalPages: 1, sort: "2", tabs: [],
          rows: domParse.listRows(SRC), breadCrumb: [],
          categories: [], hot: [], trending: [], careList: [], author: null
        };
      } catch (err) {
        console.warn("[hupu-codex] DOM 兜底解析失败", err);
      }
    }

    // 无论哪种路由，都尽量给出「导航用」的版块/热榜数据（rail 常驻）
    const nav = navData();
    return { route: r, data, nav };
  }

  /** rail 用的全局导航数据（任何页面都尽量拿到） */
  /* ============================== 登录态 ==============================
   *
   * 虎扑几套前端把 isLogin 放在完全不同的位置，不能只看一个字段：
   *
   *   页面           所在位置                         未登录时的值
   *   ─────────────────────────────────────────────────────────────
   *   首页 / 分类页   $$data.isLogin                  false
   *                   $$data.pageData.isLogin         false
   *   版块页          $$data.topic.isLogin            false   ← 之前漏的就是这个
   *   帖子详情页      没有 isLogin 字段               ——
   *                   pageProps.euid                  ""
   *                   pageProps.detail.user.puid     "0"
   *   搜索页           （都没有）                     ——
   *
   * 之前只读 $$data.isLogin，所以首页正常、一进版块（专区）就变「未登录」，
   * 详情页则因为压根没有 $$data 而永远显示未登录。
   *
   * 返回值是三态：true / false / **null（这个页面没给可用信号）**。
   * null 时界面显示中性文案 —— 宁可不说，也不能说错。
   * ==================================================================== */
  /**
   * 把一组「登没登录」的证据合成一个三态结果。
   *
   *   · 任何一个说「已登录」→ true
   *   · 全都说「未登录」    → false
   *   · 一个证据都没有        → null
   *
   * 证据互相矛盾时倾向于**说已登录**：
   * 把已登录误报成「未登录」会让用户以为登录掉了（就是这个 bug 的报障），
   * 而把未登录误报成「我的虎扑」只是多一次跳转，点了 my.hupu.com 自然会引导登录。
   */
  function pickLogin(signals) {
    let saw = false;
    for (const v of signals) {
      if (typeof v === "boolean") {
        saw = true;
        if (v) return true;
      }
    }
    return saw ? false : null;
  }

  function loginState() {
    const { sdata, next } = pageData();

    if (sdata) {
      // 同一个页面上多处都有 isLogin，全部收集起来一起判
      const v = pickLogin([
        sdata.isLogin,
        sdata.pageData && sdata.pageData.isLogin,
        sdata.topic && sdata.topic.isLogin
      ]);
      if (v !== null) return v;
    }

    const pp = next && next.props && next.props.pageProps;
    if (pp) {
      // 详情页没有 isLogin，用两个间接信号：
      //   pageProps.euid            当前登录用户的加密 id（未登录是空串）
      //   detail.user.puid          未登录是字符串 "0"
      // 两个都当证据一起判，避免其中一个缺失/异常就误判。
      const signals = [];
      if (typeof pp.euid === "string") signals.push(pp.euid !== "");
      const puid = pp.detail && pp.detail.user && pp.detail.user.puid;
      if (puid != null && String(puid) !== "") signals.push(String(puid) !== "0");

      const v = pickLogin(signals);
      if (v !== null) return v;
    }

    return null;
  }

  function navData() {
    const { sdata } = pageData();
    if (!sdata) {
      return { categories: [], hot: [], trending: [], careList: [], isLogin: loginState() };
    }
    const src = sdata.topic || sdata.pageData || {};
    return {
      categories: Array.isArray(src.categories) ? src.categories : [],
      hot: Array.isArray(src.hot) ? src.hot : [],
      trending: Array.isArray(src.trending) ? src.trending : [],
      careList: Array.isArray(sdata.careListInfo) ? sdata.careListInfo : [],
      isLogin: loginState()
    };
  }

  /* ============================== 构造 DOM 小工具 ============================== */

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  /** 清掉正文里可能干扰的东西，并把图片重建一遍（补上懒加载 / 保留原图地址） */
  function cleanContent(html) {
    if (!html) return "";
    return String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      // 行内事件处理器全去掉（onerror 之类），两个引号都照顾到
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      /*
       * 匹配 <img> 时**必须跳过引号里的内容**。
       *
       * 不能写 <img\b([^>]*)> —— 虎扑的正文里真的存在 url 里带 `>` 的地址：
       *   <img src="...?thumbnail/2000x>/quality/50/ignore-error/1"/>
       * HTML 解析器不会在引号内断标签（所以浏览器能正常加载），
       * 但 [^>]* 会从那个 `>` 处截断，属性变成一个没结尾的引号 → 认不出 src
       * → 整张图被静默删掉。实测一页能碰上两张。
       */
      .replace(/<img\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, (m) => {
        const a = m.slice(4, -1);   // 去掉 "<img" 和 结尾的 ">"
        /*
         * 属性取值必须兼容单引号和无引号。
         * 虎扑的正文里真的存在 `<img src='...' />`（同一个页面里
         * 双引号写法 55 处、单引号 1 处）—— 旧实现只认 `src="`，
         * 遇到单引号就当“没有 src”，直接 return ""，那张图会**静默消失**。
         */
        const pick = (name) => {
          const mm = a.match(new RegExp("\\s" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i"));
          if (!mm) return "";
          return mm[1] != null ? mm[1] : mm[2] != null ? mm[2] : (mm[3] || "");
        };
        const src = pick("src");
        if (!src) return "";
        const origin = pick("data-origin");
        return '<img src="' + escapeHtml(src) + '"' +
          (origin ? ' data-origin="' + escapeHtml(origin) + '"' : "") +
          ' loading="lazy" referrerpolicy="no-referrer">';
      });
  }

  /* ============================== 左 rail ============================== */

  let openedCategory = null;   // 当前展开的版块分类
  let topicsExpanded = false;  // 常用专区是否展开全部
  let careExpanded = false;

  function ensureRail(page) {
    let rail = document.querySelector(".hpcx-rail");
    if (!rail) {
      rail = el("div", "hpcx-rail");
      rail.setAttribute("data-hpcx", "");
      document.body.appendChild(rail);
    }
    renderRail(rail, page);
    return rail;
  }

  function railItem(href, icon, label, opts) {
    const o = opts || {};
    return '<a class="hpcx-rail-item' + (o.active ? " active" : "") + '" href="' + escapeHtml(href) + '"' +
      (o.title ? ' title="' + escapeHtml(o.title) + '"' : "") + ">" +
      (icon || "") +
      '<span class="hpcx-label">' + escapeHtml(label) + "</span>" +
      (o.count ? '<span class="hpcx-count">' + escapeHtml(o.count) + "</span>" : "") +
      "</a>";
  }

  function renderRail(rail, page) {
    const r = page.route;
    const nav = page.nav || {};
    const list = page.data && page.data.kind === "list" ? page.data : null;
    const det = page.data && page.data.kind === "thread" ? page.data : null;

    // 「我在哪」用专区本身的 URL 判断（list.base 会带排序后缀/-页码，不能直接比）
    const curTopic = (list && list.topicUrl) || (det && det.topic && det.topic.url) ||
      (list && list.base) || "";
    const isHome = r.kind === "list" && r.listKind === "home";

    /* 顶栏：traffic lights + 品牌 */
    rail.innerHTML =
      '<div class="hpcx-rail-traffic">' +
      '<span data-rail-drawer-close title="收起侧栏">' + ic("sidebar") + "</span>" +
      "</div>" +
      '<div class="hpcx-rail-brand">' +
      '<a class="hpcx-rail-brand-name" href="/">' + escapeHtml(brandName()) + " " + ic("chevronDown") + "</a>" +
      '<div class="hpcx-rail-brand-actions">' +
      '<span data-rail-search title="搜索（Ctrl+K）">' + ic("search") + "</span>" +
      '<span data-rail-refresh title="重新读取本页数据">' + ic("refresh") + "</span>" +
      "</div>" +
      "</div>";

    const scroll = el("div", "hpcx-rail-scroll");
    rail.appendChild(scroll);

    /* —— 主导航 —— */
    const navBox = el("nav", "hpcx-rail-nav");
    navBox.innerHTML = [
      railItem("/", ic("home"), "社区首页", { active: isHome }),
      railItem("/topic-daily", ic("fire"), "步行街主干道", { active: curTopic === "/topic-daily" }),
      railItem("/topic-daily-hot", ic("clock"), "步行街24小时榜"),
      railItem("/love", ic("heart"), "恋爱区", { active: curTopic === "/love" }),
      railItem("/nba", ic("globe"), "篮球场", { active: curTopic === "/nba" })
    ].join("");
    scroll.appendChild(navBox);

    /* —— 当前版块的操作（排序 tabs + 分页）—— */
    if (list && list.listKind === "topic") {
      // tabs[].url 是站点自己给的（/topic-daily、/topic-daily-postdate、/topic-daily-hot），
      // 直接用它，不要自己拼后缀顺序。
      const tabs = (list.tabs && list.tabs.length ? list.tabs : [
        { id: 2, title: "最新回复", url: list.base },
        { id: 1, title: "最新发布", url: list.base + "-postdate" },
        { id: 4, title: "24小时榜", url: list.base + "-hot" }
      ]).map((t) => ({ sort: String(t.id), title: t.title, url: t.url }));
      const box = el("div", "hpcx-rail-section-items");
      box.innerHTML = tabs.map((t) =>
        railItem(t.url, "", t.title, { active: String(list.sort) === t.sort })
      ).join("");
      scroll.appendChild(el("div", "hpcx-rail-section",
        "<span>排序</span>" + (list.totalPages > 1 ? '<span class="hpcx-note">共 ' + list.totalPages + " 页</span>" : "")));
      scroll.appendChild(box);
    }

    /* —— 常用专区 —— */
    const topics = QUICK_TOPICS.slice();
    if (curTopic && !topics.some((t) => t.url === curTopic) && det && det.topic) {
      topics.unshift({ name: det.topic.name, url: det.topic.url });
    }
    const shown = topicsExpanded ? topics : topics.slice(0, 8);
    const topicBox = el("div", "hpcx-rail-section-items");
    topicBox.innerHTML = shown.map((t) =>
      railItem(t.url, ic("folder"), t.name, { active: curTopic === t.url, title: t.name })
    ).join("");
    scroll.appendChild(el("div", "hpcx-rail-section",
      "<span>常用专区</span>" + (topics.length > 8
        ? '<span class="hpcx-more" data-rail-topics-toggle>' + (topicsExpanded ? "收起" : "全部 ") + "</span>"
        : "")));
    scroll.appendChild(topicBox);

    /* —— 版块分类（可折叠）—— */
    const cats = (nav.categories || []).filter((c) => c && (c.topics || []).length);
    if (cats.length) {
      scroll.appendChild(el("div", "hpcx-rail-section",
        "<span>版块分类</span><span class=\"hpcx-note\">" + cats.length + "</span>"));
      const catBox = el("div", "hpcx-rail-section-items");
      let openKey = openedCategory;
      if (openKey === null) {
        // 默认展开「当前专区所属的分类」，让 rail 一进来就能看到自己在哪
        const hit = cats.find((c) => (c.topics || []).some((t) => t.url === curTopic));
        openKey = hit ? String(hit.cateId) : "";
      }
      catBox.innerHTML = cats.map((c) => {
        const key = String(c.cateId);
        const open = openKey === key;
        const inCat = (c.topics || []).some((t) => t.url === curTopic);
        return '<div class="hpcx-cat' + (open ? " open" : "") + '" data-cat="' + escapeHtml(key) + '">' +
          '<a class="hpcx-rail-item hpcx-cat-head' + (inCat && !open ? " hint" : "") + '" href="' + escapeHtml(c.url || "#") + '">' +
          ic(open ? "folderOpen" : "folder") +
          '<span class="hpcx-label">' + escapeHtml(c.name || key) + "</span>" +
          '<span class="hpcx-cat-chev" data-cat-toggle="' + escapeHtml(key) + '">' + ic("chevronRightSm") + "</span>" +
          "</a>" +
          '<div class="hpcx-cat-body">' +
          (c.topics || []).map((t) =>
            railItem(t.url, "", t.name, { active: t.url === curTopic, count: t.countText || "" })
          ).join("") +
          "</div></div>";
      }).join("");
      scroll.appendChild(catBox);
    }

    /* —— 热榜（全部 20 个热门专区）—— */
    if ((nav.hot || []).length) {
      const box = el("div", "hpcx-rail-section-items");
      box.innerHTML = nav.hot.slice(0, 14).map((h) =>
        railItem(h.url, "", h.name, { active: curTopic === h.url, count: h.countText || "" })
      ).join("");
      scroll.appendChild(el("div", "hpcx-rail-section", "<span>热门专区</span>"));
      scroll.appendChild(box);
    }

    /* —— 全站热搜词（首页/分类页的 trending，直接是站内搜索链接）—— */
    if ((nav.trending || []).length) {
      const box = el("div", "hpcx-rail-section-items");
      box.innerHTML = nav.trending.slice(0, 10).map((t) =>
        railItem(t.url, ic("search"), t.title, { title: t.title })
      ).join("");
      scroll.appendChild(el("div", "hpcx-rail-section", "<span>全站热搜</span>"));
      scroll.appendChild(box);
    }

    /* —— careList（首页给的一批帖子）——
     *
     * 名字叫 careListInfo（“关注”），但**未登录时它也有数据** ——
     * 而原生页面在未登录时这个位置只渲染「登录后的世界更精彩 [登录]」，
     * 根本不展示这些帖子；每条还带 rec=req_id…（推荐埋点）。
     * 所以登录时才叫「我关注的帖子」，否则老实叫「帖子推荐」。
     */
    if ((nav.careList || []).length) {
      const items = careExpanded ? nav.careList : nav.careList.slice(0, 5);
      const box = el("div", "hpcx-rail-section-items");
      box.innerHTML = items.map((c) =>
        railItem("/" + c.tid + ".html", "", c.title, {
          title: (c.forum && c.forum.name ? "[" + c.forum.name + "] " : "") + c.title,
          count: c.replies || ""
        })
      ).join("");
      scroll.appendChild(el("div", "hpcx-rail-section",
        "<span>" + (nav.isLogin === true ? "我关注的帖子" : "帖子推荐") + "</span>" +
        (nav.careList.length > 5
          ? '<span class="hpcx-more" data-rail-care-toggle>' + (careExpanded ? "收起" : "全部") + "</span>"
          : "")));
      scroll.appendChild(box);
    }

    /* —— 本页话题（把当前列表页的前 15 条镜像到 rail，像 Codex 的线程列表）—— */
    if (list && list.rows.length) {
      const box = el("div", "hpcx-rail-section-items");
      box.innerHTML = list.rows.slice(0, 15).map((t) =>
        railItem(t.url, "", t.title, {
          title: t.title,
          count: t.replies ? String(t.replies) : ""
        })
      ).join("");
      scroll.appendChild(el("div", "hpcx-rail-section", "<span>本页帖子</span>"));
      scroll.appendChild(box);
    }

    /* —— 详情页：同版块热帖 / 最新 —— */
    if (det) {
      const blocks = [
        ["同版块热帖", det.sidebarHot],
        ["同版块最新", det.sidebarLatest]
      ];
      blocks.forEach(([label, rows]) => {
        if (!rows.length) return;
        const box = el("div", "hpcx-rail-section-items");
        box.innerHTML = rows.slice(0, 8).map((t) =>
          railItem(t.url, "", t.title, { title: t.title, count: t.replies ? String(t.replies) : "" })
        ).join("");
        scroll.appendChild(el("div", "hpcx-rail-section", "<span>" + label + "</span>"));
        scroll.appendChild(box);
      });
    }

    /* —— 底部：登录态 + 明暗 —— */
    const foot = el("div", "hpcx-rail-foot");
    // 三态：true 已登录 / false 未登录 / null 这个页面没给信号
    const logged = nav.isLogin;
    const userHtml = logged === true
      ? '<a class="hpcx-rail-foot-user" href="https://my.hupu.com/" target="_blank" rel="noreferrer">' +
        ic("user") + '<span class="hpcx-label">我的虎扑</span></a>'
      : logged === false
        ? '<a class="hpcx-rail-foot-user" href="' + LOGIN_URL + '" target="_blank" rel="noreferrer" title="登录">' +
          ic("user") + '<span class="hpcx-label">未登录 · 去登录</span></a>'
        // null：不知道登没登录。my.hupu.com 本来就会在未登录时引导登录，
        // 所以这里用中性文案 —— 宁可不提，也不能错说「未登录」。
        : '<a class="hpcx-rail-foot-user" href="https://my.hupu.com/" target="_blank" rel="noreferrer" title="我的虎扑">' +
          ic("user") + '<span class="hpcx-label">我的虎扑</span></a>';
    foot.innerHTML = userHtml + '<button class="hpcx-mode-btn" data-mode-toggle title="切换明暗模式"></button>';
    rail.appendChild(foot);

    /* 右缘拖拽把手 */
    const rz = el("div", "hpcx-resizer");
    rz.dataset.resize = "rail";
    rz.title = "拖拽调整侧栏宽度（双击复位）";
    rail.appendChild(rz);

    syncModeBtn();
  }

  /*
   * rail 的点击全部走「一次绑定的文档级委托」。
   *
   * 早前是在 renderRail() 里 rail.addEventListener(..., { once: true })，
   * 而 renderRail 每次 render() 都会重跑 —— 于是监听器随渲染次数线性叠加：
   * 改两次设置后一次点击会被处理三次，分类折叠变成「开了又关」（看起来没反应）、
   * 明暗切换被切三次、搜索弹出三个 prompt。改成只绑一次。
   */
  function bindRail() {
    if (bindRail._bound) return;
    bindRail._bound = true;
    document.addEventListener("click", (e) => {
      const rail = e.target.closest && e.target.closest(".hpcx-rail");
      // 注意：rail 必须显式传进去，不能在处理函数里读 e.currentTarget ——
      // 委托场景下 currentTarget 是 document，会变成 document.innerHTML = ...
      // 直接报 HierarchyRequestError。
      if (rail) onRailClick(e, rail);
    });
  }

  function onRailClick(e, rail) {
    const catToggle = e.target.closest("[data-cat-toggle]");
    if (catToggle) {
      e.preventDefault();
      const key = catToggle.dataset.catToggle;
      const cur = rail.querySelector('[data-cat="' + key + '"]');
      const willOpen = !(cur && cur.classList.contains("open"));
      rail.querySelectorAll(".hpcx-cat").forEach((n) => n.classList.remove("open"));
      if (willOpen && cur) cur.classList.add("open");
      openedCategory = willOpen ? key : "";
      return;
    }
    if (e.target.closest("[data-rail-topics-toggle]")) {
      e.preventDefault();
      topicsExpanded = !topicsExpanded;
      renderRail(rail, PAGE || collectPage());
      return;
    }
    if (e.target.closest("[data-rail-care-toggle]")) {
      e.preventDefault();
      careExpanded = !careExpanded;
      renderRail(rail, PAGE || collectPage());
      return;
    }
    if (e.target.closest("[data-rail-search]")) {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.target.closest("[data-rail-refresh]")) {
      e.preventDefault();
      // 软导航过的页面物理 DOM 是旧的，得重新拉一份当前地址；物理 DOM 直接重读
      if (!VIEW_IS_DOC) softNav(location.href, { push: false, force: true });
      else { DATA_CACHE = null; PAGE = null; render(); }
      toastNow("已重新读取数据");
      return;
    }
    if (e.target.closest("[data-mode-toggle]")) {
      e.preventDefault();
      setCfg("theme", isDarkMode() ? "light" : "dark", { visualOnly: true });
      syncMode();
      applyFavicon();
      syncModeBtn();
      return;
    }
    if (e.target.closest("[data-rail-drawer-close]")) {
      e.preventDefault();
      document.documentElement.classList.remove("hpcx-rail-open");
    }
  }

  /* ============================== 搜索 ==============================
   *
   * 虎扑有可用的站内搜索： https://bbs.hupu.com/search?q=xxx
   * （首页的「全站热搜」链接就是它拼出来的，所以格式是官方行为，不是我们猜的）
   * ================================================================= */

  function openSearch() {
    const q = window.prompt("搜索虎扑社区（回车打开搜索结果）", "");
    if (!q) return;
    window.open(HOME + "/search?q=" + encodeURIComponent(q), "_blank", "noopener");
  }

  /* ============================== 主区骨架 ============================== */

  function ensureMain() {
    let main = document.querySelector(".hpcx-main");
    if (main) return main;

    main = el("main", "hpcx-main");
    main.innerHTML =
      '<div class="hpcx-thread-col">' +
      '<header class="hpcx-topbar">' +
      '<button class="hpcx-icon-btn hpcx-menu-btn" title="打开侧栏">' + ic("menu") + "</button>" +
      '<a class="hpcx-icon-btn" href="/" title="返回社区首页">' + ic("folder") + "</a>" +
      '<div class="hpcx-crumb"><span class="hpcx-proj"></span><span class="hpcx-sep">/</span><span class="hpcx-model"></span></div>' +
      '<div class="hpcx-spacer"></div>' +
      '<div class="hpcx-icon-btn" data-settings-open title="设置（Ctrl+,）">' + ic("gear") + "</div>" +
      '<div class="hpcx-icon-btn hpcx-panel-toggle" data-panel-toggle title="显示 / 隐藏代码面板">' + ic("panel") + "</div>" +
      '<a class="hpcx-icon-btn" href="' + escapeHtml(location.href) + '" target="_blank" rel="noopener" title="在原生页面打开">' + ic("external") + "</a>" +
      '<div class="hpcx-icon-btn" data-copy-link title="复制当前链接">' + ic("dots") + "</div>" +
      "</header>" +
      '<div class="hpcx-thread"><div class="hpcx-thread-inner"></div></div>' +
      '<div class="hpcx-composer-wrap"></div>' +
      "</div>" +
      '<aside class="hpcx-code-col">' +
      '<div class="hpcx-code-head">' +
      '<div class="hpcx-code-tabs">' +
      '<span class="hpcx-code-tab on"><span class="hpcx-code-ic" data-code-icon>RS</span><span data-code-file-name>topic_cache.rs</span></span>' +
      '<span class="hpcx-code-tab" data-code-mode-tab title="切换 代码 / diff">diff</span>' +
      "</div>" +
      '<div class="hpcx-code-tools">' +
      '<button class="hpcx-lang-btn" data-lang-btn><span data-lang-label>Rust</span>' + ic("chevronDown") + "</button>" +
      '<div class="hpcx-lang-menu" data-lang-menu hidden></div>' +
      "</div>" +
      "</div>" +
      '<div class="hpcx-code-crumb">' +
      "<span data-code-crumb-root></span><i>/</i>" +
      "<span data-code-crumb-cat></span><i>/</i>" +
      "<span data-code-crumb-dir></span><i>/</i>" +
      "<span data-code-crumb-file></span>" +
      "</div>" +
      '<div class="hpcx-code-body" data-code-body></div>' +
      '<div class="hpcx-code-foot"><span data-code-status>ready</span><span>UTF-8</span><span>Ln 1, Col 1</span></div>' +
      // 面板的左缘拖拽把手（右栏在右侧，所以手柄也在左边缘）
      '<div class="hpcx-resizer" data-resize="panel" title="拖拽调整代码面板宽度（双击复位）"></div>' +
      "</aside>";
    main.setAttribute("data-hpcx", "");
    document.body.appendChild(main);

    // 顶栏 / 面板事件
    main.addEventListener("click", (e) => {
      if (e.target.closest("[data-settings-open]")) { openSettings(); return; }
      if (e.target.closest("[data-panel-toggle]")) {
        setPanelHidden(!panelHidden(), true);
        return;
      }
      if (e.target.closest("[data-copy-link]")) {
        copyText(location.href);
        return;
      }
      if (e.target.closest("[data-code-mode-tab]")) {
        setCfg("codeMode", getCodeMode() === "diff" ? "code" : "diff");
        return;
      }
      if (e.target.closest("[data-lang-btn]")) {
        const m = main.querySelector("[data-lang-menu]");
        if (m) m.hidden = !m.hidden;
        return;
      }
      const langItem = e.target.closest("[data-code-lang-item]");
      if (langItem) {
        setCfg("lang", langItem.dataset.codeLangItem);
        const m = main.querySelector("[data-lang-menu]");
        if (m) m.hidden = true;
        return;
      }
      if (e.target.closest(".hpcx-menu-btn")) {
        document.documentElement.classList.toggle("hpcx-rail-open");
      }
    });

    bindResizers(main);
    bindComposer(main);
    return main;
  }

  function threadInner() {
    return document.querySelector(".hpcx-main .hpcx-thread-inner");
  }

  function syncChrome(page) {
    const main = document.querySelector(".hpcx-main");
    if (!main) return;
    const r = page.route;
    const proj = main.querySelector(".hpcx-proj");
    const model = main.querySelector(".hpcx-model");
    const d = page.data;

    if (r.kind === "thread" && d) {
      proj.textContent = (d.topic && d.topic.name) || "帖子";
      model.textContent = d.title;
      model.title = d.title;
    } else if (r.kind === "list" && d) {
      proj.textContent = d.listKind === "home" ? "虎扑社区" : (d.title || "版块");
      model.textContent = "共 " + d.rows.length + " 条";
      model.title = "";
    } else {
      proj.textContent = "虎扑社区";
      model.textContent = location.pathname;
    }
  }

  /* ============================== 视图渲染 ============================== */

  let PAGE = null;
  let NATIVE_TITLE = null;

  /** 上一次 render 是否拿到了页面数据（用于决定要不要继续重试） */
  let RENDERED_WITH_DATA = false;

  function render() {
    if (NATIVE_TITLE === null) { NATIVE_TITLE = document.title; DOC_TITLE = document.title; }
    const page = collectPage();
    PAGE = page;
    const r = page.route;
    syncTitle();
    RENDERED_WITH_DATA = !!page.data;

    if (!isSupported(r) || !page.data) {
      // 不接管：摘掉 LOCK 和 BOOT，原生页面完全恢复，只留 rail
      document.documentElement.classList.remove(LOCK_CLASS, BOOT_CLASS);
      document.querySelector(".hpcx-main")?.remove();
      ensureRail(page);
      bindResizers(null);
      return;
    }

    // 接管成功：BOOT 的使命结束，交给 LOCK（BOOT 用 visibility、LOCK 用 display:none）
    document.documentElement.classList.remove(BOOT_CLASS);
    document.documentElement.classList.add(LOCK_CLASS);
    ensureRail(page);
    ensureMain();
    syncChrome(page);

    const inner = threadInner();
    if (!inner) return;

    if (r.kind === "thread") renderDetail(inner, page);
    else renderList(inner, page);

    // 底部草稿板：列表页和详情页共用，但要挂在 render 里统一同步
    // （之前只在 renderDetail 里调用，列表页就一直没有草稿板）
    syncComposer(page);

    renderCodePanel();
  }

  /* ---------- 列表视图 ---------- */

  function rowHtml(t) {
    const sub = [];
    if (t.topic && t.topic.name) {
      sub.push('<span class="hpcx-node">' + escapeHtml(t.topic.name) + "</span>");
    }
    if (t.author && t.author.name) sub.push("<span>@" + escapeHtml(t.author.name) + "</span>");
    if (t.read) sub.push("<span>" + t.read.toLocaleString("en-US") + " 浏览</span>");

    const hot = t.lights > 0;
    return '<a class="hpcx-row" href="' + escapeHtml(t.url) + '"' +
      ' title="' + escapeHtml(t.title + (t.author && t.author.name ? "  ·  " + t.author.name : "")) + '">' +
      '<span class="hpcx-row-avatar' + (hot ? " hot" : "") + '"></span>' +
      '<span class="hpcx-row-texts">' +
      '<span class="hpcx-row-title">' + escapeHtml(t.title) + "</span>" +
      (sub.length ? '<span class="hpcx-row-sub">' + sub.join("") + "</span>" : "") +
      "</span>" +
      '<span class="hpcx-row-meta">' +
      (t.replies ? '<span class="hpcx-replies">' + t.replies + " 回复</span>" : "") +
      (t.lights ? '<span class="hpcx-row-lights">' + t.lights + " 亮</span>" : "") +
      '<span class="hpcx-time">' + escapeHtml(formatTime(t.timeMs) || t.timeText || "") + "</span>" +
      "</span>" +
      "</a>";
  }

  /**
   * 列表行之间的 agent 痕迹。
   * 列表页是最容易被一眼看穿的地方，所以在行与行之间按种子插「思考行 / 工具调用行」，
   * 让整页读起来像一份 agent 会话日志，而不是论坛帖子流。
   * 密度刻意压低：太密会盖住标题，反而更奇怪。
   */
  function listTraceHtml(t, idx, avoidRun) {
    const sep = { html: '<div class="hpcx-row-sep"></div>', run: avoidRun };
    if (!cfg("decorations")) return sep;
    const rate = Math.max(0, Math.min(100, Number(cfg("listTraceRate")) || 0));
    if (rate <= 0) return sep;

    const rnd = mulberry32((((idx + 1) * 2654435761) ^ num(t.tid)) >>> 0);
    const roll = rnd() * 100;
    if (roll >= rate) return sep;
    if (roll < rate / 2) {
      return { html: thinkingHtml(rnd, !!cfg("listThinkingOpen")), run: avoidRun };
    }
    const p = runlineParts(rnd, avoidRun);
    return { html: p.html, run: p.idx };
  }

  function listRowsHtml(rows) {
    const out = [];
    let lastRun = -1;
    rows.forEach((t, i) => {
      if (i > 0) {
        const trace = listTraceHtml(t, i, lastRun);
        lastRun = trace.run;
        out.push(trace.html);
      }
      out.push(rowHtml(t));
    });
    return out.join("");
  }

  function renderList(inner, page) {
    const d = page.data;
    const rows = d.rows || [];

    // 排序 chips（版块页才有）—— 同样用站点给的 tabs[].url
    let chips = "";
    if (d.listKind === "topic") {
      const tabs = (d.tabs && d.tabs.length ? d.tabs : [
        { id: 2, title: "最新回复", url: d.base },
        { id: 1, title: "最新发布", url: d.base + "-postdate" },
        { id: 4, title: "24小时榜", url: d.base + "-hot" }
      ]).map((t) => ({ sort: String(t.id), title: t.title, url: t.url }));
      chips = '<div class="hpcx-filter-row">' + tabs.map((t) =>
        '<a class="hpcx-fchip' + (String(d.sort) === t.sort ? " on" : "") + '" href="' +
        escapeHtml(t.url) + '">' + escapeHtml(t.title) + "</a>"
      ).join("") + "</div>";
    }

    // 分类页/首页：把该分类下的专区列成 chips
    let topicChips = "";
    if (d.listKind === "category" && page.nav && page.nav.categories) {
      const cate = page.nav.categories.find((c) => String(c.cateId) === String((d.categoryInfo || {}).cateId || ""));
      if (cate && (cate.topics || []).length) {
        topicChips = '<div class="hpcx-filter-row">' + cate.topics.map((t) =>
          '<a class="hpcx-fchip" href="' + escapeHtml(t.url) + '">' + escapeHtml(t.name) + "</a>"
        ).join("") + "</div>";
      }
    }

    // 分页
    let pager = "";
    if (d.totalPages > 1) {
      pager = renderListPager(d);
    }

    inner.innerHTML = '<div class="hpcx-head">' +
      // 版块名 + 帖数放同一行：原来那个大卡片（logo / 描述 / 原生页面 / 24小时榜）
      // 跟这里的标题、下面的 hpcx-head-desc、右侧的 chips 全是重复的，整块拿掉了
      '<div class="hpcx-head-title"><h1>' + escapeHtml(d.title) + "</h1>" +
      (d.countText ? '<span class="hpcx-pill">' + escapeHtml(d.countText) + " 帖</span>" : "") +
      "</div>" +
      (d.listKind === "topic"
        ? '<button type="button" class="hpcx-new-topic-btn" data-publish title="在当前版块发新帖">' +
          ic("plus") + "发新帖</button>" +
          '<a class="hpcx-new-topic-btn ghost" href="' + escapeHtml(d.base) + '" target="_blank" rel="noopener" title="去原生列表页">' +
          ic("external") + "原生</a>"
        : "") +
      "</div>" +
      chips + topicChips +
      '<div class="hpcx-head-desc">' + escapeHtml(d.desc || "") +
      (d.page > 1 ? " · 第 " + d.page + " / " + d.totalPages + " 页" : "") + "</div>" +
      '<div class="hpcx-rows">' + listRowsHtml(rows) + "</div>" +
      (pager || '<div class="hpcx-list-status">' + (rows.length ? "没有更多了" : "这个列表是空的") + "</div>");

    // 详情页的右侧热帖，也顺手在列表页展示一下推荐（首页的 trending / recommend）
    const extra = [];
    if ((d.trending || []).length) extra.push(["全站热搜", d.trending.map((t) => ({ title: t.title, url: t.url }))]);
    if ((d.careList || []).length) extra.push([
      page.nav && page.nav.isLogin === true ? "我关注的帖子" : "帖子推荐",
      d.careList.map((c) => ({ title: c.title, url: "/" + c.tid + ".html", replies: c.replies }))
    ]);
    if (extra.length) {
      inner.insertAdjacentHTML("beforeend", extra.map(([label, items]) =>
        '<div class="hpcx-head" style="margin-top:24px"><div class="hpcx-head-title"><h1 style="font-size:13px">' +
        escapeHtml(label) + "</h1></div></div>" +
        '<div class="hpcx-card-links">' + items.slice(0, 24).map((t) =>
          '<a class="hpcx-pill" href="' + escapeHtml(t.url) + '" title="' + escapeHtml(t.title) + '">' +
          escapeHtml(t.title.length > 28 ? t.title.slice(0, 28) + "…" : t.title) + "</a>"
        ).join("") + "</div>"
      ).join(""));
    }
  }

  /** 版块页分页：上下页 + 页码 + 跳转 */
  function renderListPager(d) {
    const total = d.totalPages || 1;
    const cur = d.page || 1;
    const links = [];
    const push = (n) => {
      if (n < 1 || n > total) return;
      links.push('<a class="hpcx-fchip' + (n === cur ? " on" : "") + '" href="' +
        escapeHtml(listPageUrl(d.base, n)) + '">' + n + "</a>");
    };
    push(cur - 1);
    const win = [];
    for (let i = Math.max(1, cur - 3); i <= Math.min(total, cur + 3); i++) win.push(i);
    if (win[0] > 1) { push(1); if (win[0] > 2) links.push('<span class="hpcx-fchip ghost">…</span>'); }
    win.forEach(push);
    if (win[win.length - 1] < total) {
      if (win[win.length - 1] < total - 1) links.push('<span class="hpcx-fchip ghost">…</span>');
      push(total);
    }
    push(cur + 1);
    return '<div class="hpcx-list-status pager">' + links.join("") + "</div>";
  }

  /* ============================== agent 装饰（假内容） ==============================
   *
   * 给「上班摸鱼」用的核心伪装：每条回复顶部混入一个 agent 思考块，
   * 部分回复里穿插淡色的「工具调用」行。
   * 全部按 (帖子 id, 楼层号) 播种 —— 同一楼层每次刷新长得一样，不会闪。
   * 文案是英文的，因为 Codex / Claude Code 的思考块本来就是英文；
   * 而且英文更不像「论坛内容」，一眼扫过去就是工具输出。
   * ============================================================================== */

  const THINK_OPENERS = [
    "Okay, let me think through this properly.",
    "Alright, reading the post again — the claim hinges on one assumption.",
    "So the question is essentially about trade-offs, not correctness.",
    "Hmm, this is more subtle than it first looks.",
    "Let me unpack what's actually being claimed here before reacting.",
    "First instinct: this is a config issue masquerading as a bug.",
    "Let me separate the diagnosis from the proposed fix.",
    "There's a decent argument on both sides here, which is worth admitting up front.",
    "I've seen this pattern before — it usually ends up being permissions.",
    "Reproducing it locally would settle half of this thread instantly.",
    "The tone is confident; the evidence is thinner than it sounds.",
    "Before agreeing, I want to check the failure mode this implies."
  ];

  const THINK_MIDS = [
    "The most likely explanation is resource contention, not the code path itself.",
    "If the numbers hold under a controlled benchmark, the conclusion is solid; if not, it's measurement noise.",
    "There are two ways to verify this: profile it under load, or bisect the change.",
    "I should distinguish between what the author measured and what they inferred.",
    "The failure mode only shows up under load, which is exactly why it's easy to miss.",
    "Correlation is doing a lot of work in that argument — worth pointing out gently.",
    "The simple approach probably wins here; the clever one just moves the complexity.",
    "Backwards compatibility matters more than elegance in this specific case.",
    "Queueing delay would explain the tail latency better than throughput does.",
    "Caching is the obvious lever, but it only helps if the read path is actually hot.",
    "This smells like an ordering problem: the cleanup runs before the flush.",
    "In practice the config default wins; nobody reads the docs that deeply.",
    "Two people in this thread are describing the same symptom with different vocabularies."
  ];

  const THINK_CLOSERS = [
    "Let me structure the reply around the one number that matters.",
    "I'll keep it short and ask the question that actually needs answering.",
    "I should avoid sounding dismissive — the work is genuinely good.",
    "Okay, writing it out step by step is the right move here.",
    "One concrete suggestion beats three abstract ones. Going with that.",
    "I'll agree with the direction, then flag the one thing that could bite later.",
    "Better to leave a question than a lecture — keeping the reply to two points.",
    "Let me lead with the concrete number, then the caveat.",
    "I'll ask for the reproduction steps before committing to a diagnosis.",
    "Wrapping up with the fix I'd actually ship, not the one that sounds smart.",
    "That's enough analysis — the practical next step is obvious."
  ];

  /** 楼内穿插的「工具调用」行（纯装饰，英文对齐 Codex CLI） */
  const RUN_LINES = [
    ["terminal", "Running command", true],
    ["file", "Reading file", false],
    ["globe", "Searching the web", false],
    ["folder", "Listing directory", false],
    ["check", "Applied changes", false],
    ["globe", "Fetched page", false],
    ["branch", "Checked out branch", false],
    ["clock", "Waiting on build", false]
  ];
  const RUN_CMDS = [
    "cargo build --release", "npm run build", "pytest -q tests/cache",
    "go test ./...", "git diff --stat", "ls src/", "make lint",
    "npm test -- --filter=auth", "cargo test --release", "go vet ./...",
    "docker compose up -d", "kubectl get pods -n prod", "rg -n 'ttl' src/",
    "git log --oneline -8", "node --check dist/app.js", "ruff check ."
  ];

  /** 每个楼层一个稳定种子：同一帖子同一楼层永远得到同一套装饰 */
  function turnSeed(topicId, key) {
    const s = String(key == null ? "" : key);
    // 纯数字（普通楼层）走乘法散列；否则（亮评用 pid）先字符串哈希
    let n = /^\d+$/.test(s) ? Number(s) : 0;
    if (!n) {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      n = h >>> 0;
    }
    return (((n * 7919 + 1) * 2654435761) ^ num(topicId)) >>> 0;
  }

  function thinkSentences(rnd) {
    const pick = (pool) => pool[Math.floor(rnd() * pool.length)];
    const out = [pick(THINK_OPENERS)];
    if (rnd() < 0.65) out.push(pick(THINK_MIDS));
    if (rnd() < 0.60) out.push(pick(THINK_CLOSERS));
    return out;
  }

  function thinkingHtml(rnd, openByDefault) {
    const secs = 2 + Math.floor(rnd() * 46);
    return '<div class="hpcx-think' + (openByDefault ? " open" : "") + '">' +
      '<div class="hpcx-think-head"><span class="hpcx-spin">' + ic("sparkle") + "</span>" +
      '<span>Worked for ' + secs + 's</span><span class="hpcx-think-chev"></span></div>' +
      '<div class="hpcx-think-body">' + escapeHtml(thinkSentences(rnd).join("\n\n")) + "</div>" +
      "</div>";
  }

  function runlineParts(rnd, avoidIdx) {
    let i = Math.floor(rnd() * RUN_LINES.length);
    if (avoidIdx != null && avoidIdx >= 0 && i === avoidIdx) i = (i + 1) % RUN_LINES.length;
    const [icon, text, withCmd] = RUN_LINES[i];
    return {
      idx: i,
      html: '<div class="hpcx-runline">' + (icon ? ic(icon) : "") +
        "<span>" + escapeHtml(text) + "</span>" +
        (withCmd ? "<code>" + escapeHtml(RUN_CMDS[Math.floor(rnd() * RUN_CMDS.length)]) + "</code>" : "") +
        "</div>"
    };
  }

  /**
   * 给一批已渲染的楼层加伪装装饰。在 detached 容器上调用（改完再序列化进页面）。
   * 覆盖率：~70% 楼层带思考块，其中 ~28% 额外掺 1-2 条工具调用行。
   */
  function decorateTurns(container, topicId) {
    if (!container || !cfg("decorations")) return;
    container.querySelectorAll(".hpcx-turn-agent[data-floor]").forEach((turn) => {
      if (turn.dataset.decorated === "1") return;
      turn.dataset.decorated = "1";
      const cooked = turn.querySelector(".hpcx-cooked");
      if (!cooked) return;
      const rnd = mulberry32(turnSeed(topicId, turn.dataset.seed));

      // 思考块放内容最前面（要在 runline 判断之前，否则覆盖率会掉）
      if (rnd() < 0.70) {
        const holder = el("div");
        holder.innerHTML = thinkingHtml(rnd, !!cfg("detailThinkingOpen"));
        cooked.prepend(holder.firstChild);
      }
      if (cooked.children.length < 2) return;
      if (rnd() < 0.72) return;

      const n = rnd() < 0.22 ? 2 : 1;
      const kids = [...cooked.children];
      let lastRun = -1;
      for (let k = 0; k < n; k++) {
        const parts = runlineParts(rnd, lastRun);
        lastRun = parts.idx;
        const holder = el("div");
        holder.innerHTML = parts.html;
        const line = holder.firstChild;
        // 多数插在末尾（读起来像这步刚跑完），偶尔插在中间
        const at = rnd() < 0.7 ? kids.length : Math.max(1, Math.floor(rnd() * kids.length));
        kids[at - 1].insertAdjacentElement("afterend", line);
        kids.splice(at, 0, line);
      }
    });
  }

  /* ---------- 引用卡片 ---------- */

  function quoteHtml(q) {
    const body = cleanContent(q.contentHtml || "")
      // 引号内的 > 不能断标签（虎扑有 url 里带 > 的图），
      // 否则会截不干净，把 url 尾巴当正文漏出来
      .replace(/<img\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi, '<span class="hpcx-quote-img">[图片]</span>');
    return '<div class="hpcx-quote' + (cfg("quoteOpen") ? " open" : "") + '">' +
      '<div class="hpcx-quote-head">' +
      '<span class="hpcx-quote-ic">' + ic("quote") + "</span>" +
      '<span class="hpcx-quote-title">引用' + (q.authorName ? " " + escapeHtml(q.authorName) : "") +
      (q.lights ? " · " + q.lights + " 亮" : "") + "</span>" +
      '<span class="hpcx-quote-chev"></span>' +
      "</div>" +
      '<div class="hpcx-quote-body">' + (body || '<span class="hpcx-dim">（引用内容为空）</span>') + "</div>" +
      "</div>";
  }

  /* ---------- 详情视图 ---------- */

  function renderDetail(inner, page) {
    const d = page.data;
    if (!d) {
      inner.innerHTML = '<div class="hpcx-list-status">没能解析出帖子内容。</div>';
      return;
    }

    const meta = [];
    meta.push("<span>" + escapeHtml(formatTime(d.timeMs) || d.timeText || "") + "</span>");
    if (d.location) meta.push('<span class="hpcx-dotsep">·</span><span>' + escapeHtml(d.location) + "</span>");
    meta.push('<span class="hpcx-dotsep">·</span><span>' + d.read.toLocaleString("en-US") + " 浏览</span>");
    meta.push('<span class="hpcx-dotsep">·</span><span>' + d.replies + " 回复</span>");
    if (d.lights) meta.push('<span class="hpcx-dotsep">·</span><span>' + d.lights + " 亮</span>");
    if (d.page > 1) meta.push('<span class="hpcx-dotsep">·</span><span>第 ' + d.page + " 页</span>");

    const crumb = (d.breadCrumb || []).slice(0, -1).map((b) =>
      '<a class="hpcx-crumb-link" href="' + escapeHtml(b.url) + '">' + escapeHtml(b.title) + "</a>"
    ).join('<span class="hpcx-dotsep">›</span>');

    const head = '<div class="hpcx-detail-head">' +
      (crumb ? '<div class="hpcx-detail-crumb">' + crumb + "</div>" : "") +
      // 不再重复渲染大标题：顶栏面包屑已经是「版块 / 标题」了，
      // 正文里再抄一个 h1 纯属重复占位（顶栏标题带 title 属性，长了悬停可看全）
      '<div class="hpcx-detail-meta">' +
      (d.author.url
        ? '<a href="' + escapeHtml(d.author.url) + '" target="_blank" rel="noreferrer" class="hpcx-user">' + escapeHtml(d.author.name) + "</a>"
        : '<span class="hpcx-user">' + escapeHtml(d.author.name) + "</span>") +
      (d.author.level ? '<span class="hpcx-badge">Lv' + d.author.level + "</span>" : "") +
      '<span class="hpcx-badge op">楼主</span>' +
      meta.join("") +
      "</div></div>";

    const opTurn = '<div class="hpcx-turn">' +
      '<div class="hpcx-turn-user"><div class="hpcx-turn-user-bubble">' +
      (d.hasContent ? cleanContent(d.contentHtml) : '<span class="hpcx-dim">（楼主只发了图片或正文为空 —— 点下面「原生页面」看原帖）</span>') +
      "</div></div>" +
      '<div class="hpcx-worked">' +
      '<span class="hpcx-floor">OP</span>' +
      '<span class="hpcx-user">' + escapeHtml(d.author.name) + "</span>" +
      '<span class="hpcx-dotsep">·</span><span>' + escapeHtml(formatTime(d.timeMs) || d.timeText || "") + "</span>" +
      turnActionsHtml({ floor: "OP", username: d.author.name, tid: d.tid }) +
      "</div></div>";

    // 亮评（虎扑特色：被点亮最多的回复单独一栏）
    /*
     * 亮评区：单独一个带底色的卡片，并且可折叠。
     * 以前只把分隔线文字染成强调色，正文里跟普通回复长得一模一样 ——
     * 用户基本分不出“亮评”和“回复”的边界在哪。
     */
    const lightsHtml = (cfg("showLights") && d.lightsList.length)
      ? '<section class="hpcx-lights' + (cfg("lightsCollapsed") ? " collapsed" : "") + '" data-lights>' +
        '<div class="hpcx-lights-head" data-lights-toggle role="button" tabindex="0"' +
        ' title="点击折叠 / 展开亮评">' +
        '<span class="hpcx-lights-ic">' + ic("bulb") + "</span>" +
        '<span class="hpcx-lights-title">亮评</span>' +
        '<span class="hpcx-lights-count">' + d.lightsList.length + " 条</span>" +
        '<span class="hpcx-lights-note">被点亮最多的回复</span>' +
        '<span class="hpcx-lights-chev"></span>' +
        "</div>" +
        '<div class="hpcx-lights-body">' +
        d.lightsList.map((p) => turnHtml(p, d)).join("") +
        "</div></section>"
      : "";

    const turnsHtml = d.turns.length
      ? '<div class="hpcx-turn-divider">第 ' + d.page + " / " + d.totalPages + " 页 · " +
      ((d.page - 1) * d.size + 1) + " - " + ((d.page - 1) * d.size + d.turns.length) + " 楼（共 " + d.replies + " 回复）</div>" +
      d.turns.map((p) => turnHtml(p, d)).join("")
      : '<div class="hpcx-turn-divider">还没有回复</div>';

    // 分页
    let pager = "";
    if (d.totalPages > 1) {
      const links = [];
      const push = (n) => {
        if (n < 1 || n > d.totalPages) return;
        links.push('<a class="hpcx-fchip' + (n === d.page ? " on" : "") + '" href="' +
          escapeHtml(threadPageUrl(d.tid, n)) + '">' + n + "</a>");
      };
      push(d.page - 1);
      const win = [];
      for (let i = Math.max(1, d.page - 3); i <= Math.min(d.totalPages, d.page + 3); i++) win.push(i);
      if (win[0] > 1) { push(1); if (win[0] > 2) links.push('<span class="hpcx-fchip ghost">…</span>'); }
      win.forEach(push);
      if (win[win.length - 1] < d.totalPages) {
        if (win[win.length - 1] < d.totalPages - 1) links.push('<span class="hpcx-fchip ghost">…</span>');
        push(d.totalPages);
      }
      push(d.page + 1);
      pager = '<div class="hpcx-list-status pager">' + links.join("") + "</div>";
    } else {
      pager = '<div class="hpcx-list-status">没有更多回复了</div>';
    }

    // 先在 detached 容器里渲染 + 加伪装装饰，再一次性写回：
    // decorateTurns 要动 DOM（prepend / insert），在字符串上做不了。
    const holder = document.createElement("div");
    holder.innerHTML = head + opTurn + lightsHtml + turnsHtml + pager +
      '<div class="hpcx-card-links" style="margin-top:20px;align-items:center">' +
      '<a class="hpcx-new-topic-btn" href="' + escapeHtml(location.href) + '" target="_blank" rel="noopener">' +
      ic("external") + "原生页面（回帖 / 亮 / 收藏）</a>" +
      '<span class="hpcx-dim">回帖需要登录，本脚本不改你的登录态</span>' +
      "</div>";
    decorateTurns(holder, d.tid);
    prepareContentImages(holder);
    inner.replaceChildren(...holder.childNodes);
  }

  function turnHtml(p, d) {
    const meta = [];
    meta.push('<span class="hpcx-dotsep">·</span><span>' + escapeHtml(formatTime(p.timeMs) || p.timeText || "") + "</span>");
    if (p.location) meta.push('<span class="hpcx-dotsep">·</span><span>' + escapeHtml(p.location) + "</span>");
    if (p.lights) {
      meta.push('<span class="hpcx-dotsep">·</span><span><span data-light-count>' +
        p.lights + "</span> 亮</span>");
    }
    if (p.replyNum) meta.push('<span class="hpcx-dotsep">·</span><span>' + p.replyNum + " 条回复</span>");

    return '<div class="hpcx-turn">' +
      '<div class="hpcx-turn-agent"' +
      (/^\d+$/.test(p.floor) ? ' id="reply' + escapeHtml(p.floor) + '"' : "") +
      ' data-floor="' + escapeHtml(p.floor) + '" data-seed="' + escapeHtml(p.seed) + '">' +
      (cfg("quoteCard") && p.quote ? quoteHtml(p.quote) : "") +
      '<div class="hpcx-cooked">' + cleanContent(p.contentHtml) + "</div>" +
      '<div class="hpcx-worked">' +
      '<span class="hpcx-floor">' + escapeHtml(p.floor) + "</span>" +
      (p.author.url
        ? '<a class="hpcx-user" href="' + escapeHtml(p.author.url) + '" target="_blank" rel="noreferrer">' + escapeHtml(p.author.name) + "</a>"
        : '<span class="hpcx-user">' + escapeHtml(p.author.name) + "</span>") +
      meta.join("") +
      turnActionsHtml({ floor: p.floor, username: p.author.name, tid: d.tid, pid: p.pid, lit: p.isLighted }) +
      "</div></div></div>";
  }

  /**
   * 楼层操作胶囊。
   * 虎扑的「亮」是服务端行为且要登录，脚本不去伪造成功，
   * 所以这里只做两件确定能做对的事：
   *   回复     → 把「> 引用原文 / 回复 @某人」写进底部草稿
   *   复制楼层 → 复制该楼的原生链接（/<tid>.html#reply<floor> 用页内锚点没法定位，
   *              所以复制的是「帖子链接 + 楼层号」的文本形式，粘出去能自己找）
   *   亮/收藏  → 直接跳原生页面（链接可点，由站点自己处理登录）
   */
  function turnActionsHtml(o) {
    const link = HOME + "/" + o.tid + ".html";
    return '<span class="hpcx-actions">' +
      '<button class="hpcx-act" data-act="reply" data-user="' + escapeHtml(o.username || "") +
      '" data-floor="' + escapeHtml(String(o.floor)) + '" data-pid="' + escapeHtml(String(o.pid || "")) +
      '" title="回复该楼层">' +
      ic("reply") + "<span>回复</span></button>" +
      // 点亮只针对回复：主楼没有 pid，就干脆不给这个按钮
      // （原生页面上主楼是「推荐」，不是「亮」）
      (o.pid
        ? '<button class="hpcx-act hpcx-act-light' + (o.lit ? " on" : "") + '" data-act="light"' +
          ' data-pid="' + escapeHtml(String(o.pid)) + '" data-lit="' + (o.lit ? "1" : "0") +
          '" title="' + (o.lit ? "取消点亮" : "点亮这一楼") + '">' +
          ic("heart") + "<span>" + (o.lit ? "已亮" : "亮") + "</span></button>"
        : "") +
      '<button class="hpcx-act" data-act="copy-floor" data-value="' +
      escapeHtml(link + "  （" + o.floor + " 楼）") + '" title="复制该楼链接">' +
      ic("link") + "<span>复制</span></button>" +
      "</span>";
  }

  function handleTurnAction(act) {
    const kind = act.dataset.act;
    if (kind === "light") { toggleLight(act); return; }
    if (kind === "copy-floor") {
      copyText(act.dataset.value || location.href);
      return;
    }
    if (kind === "reply") {
      const user = act.dataset.user || "";
      const floor = act.dataset.floor || "";
      const pid = act.dataset.pid || "";
      const turn = act.closest(".hpcx-turn");
      const src = turn && turn.querySelector(".hpcx-cooked");
      // 引用原文（去掉装饰块）：纯文本用来拼草稿，HTML 交给接口当 atc_content
      let quoted = "";
      let quotedHtml = "";
      if (src) {
        const clone = src.cloneNode(true);
        clone.querySelectorAll(".hpcx-think, .hpcx-runline").forEach((n) => n.remove());
        quoted = txt(clone).slice(0, 120);
        quotedHtml = clone.innerHTML;
      }
      const edit = composerEditor();
      if (!edit) {
        toastNow("草稿框还没准备好");
        return;
      }

      if (loginState() !== false && pid) {
        /*
         * 已登录 + 有 pid：做成真正的楼中楼。
         * 引用内容不用塞进正文 —— 接口有专门的 pid / data.atc_content，
         * 原生帖子就是这么回的，正文里只留一个 @。
         */
        REPLY_TARGET = { pid, floor, author: user, contentHtml: quotedHtml };
        renderReplyTarget();
        const at = user ? "@" + user + " " : "";
        if (at && (edit.textContent || "").indexOf(at) !== 0) {
          edit.textContent = at + (edit.textContent || "");
          setCaret(edit, at.length);
        }
        syncComposerState();
        toastNow("将回复第 " + floor + " 楼" + (user ? " @" + user : ""));
      } else {
        // 未登录（或回楼主）：把引用原文写进草稿，方便复制到原生回复框
        REPLY_TARGET = null;
        renderReplyTarget();
        const before = (quoted ? "> " + quoted + "\n\n" : "") + (user ? "@" + user + " " : "");
        edit.textContent = before + (edit.textContent || "");
        setCaret(edit, before.length);
        syncComposerState();
        toastNow("已写入草稿（第 " + floor + " 楼）");
      }

      edit.focus();
      // jsdom 之类没实现 scrollIntoView，别让整个点击处理器炸掉
      const box = document.querySelector(".hpcx-composer");
      if (box && typeof box.scrollIntoView === "function") {
        box.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
  }

  /* ============================== 右侧代码面板（纯氛围） ============================== */

  const CODE_LANGS = {
    rust: {
      label: "Rust", file: "topic_cache.rs", dir: "engine", icon: "RS", comment: "//",
      renames: [["entries", "cache"], ["ttl", "ttl_ms"], ["fetched_at", "cached_at"], ["offset", "start"], ["limit", "page_size"]],
      kw: ["fn", "let", "mut", "impl", "pub", "use", "struct", "enum", "match", "if", "else", "for", "in", "return", "mod", "crate", "self", "Self", "async", "await", "move", "where", "const", "trait", "loop", "while", "Ok", "Err", "Some", "None", "Box", "Vec", "String", "Result", "Option"],
      blocks: [
        ["use std::collections::HashMap;", "use std::time::{Duration, Instant};", ""],
        ["pub struct TopicCache {", "    entries: HashMap<u64, CachedTopic>,", "    ttl: Duration,", "}", ""],
        ["pub struct CachedTopic {", "    id: u64,", "    title: String,", "    replies: usize,", "    fetched_at: Instant,", "}", ""],
        ["impl TopicCache {", "    pub fn new(ttl: Duration) -> Self {", "        Self { entries: HashMap::new(), ttl }", "    }", "}", ""],
        ["    pub fn get(&self, id: u64) -> Option<&CachedTopic> {", "        match self.entries.get(&id) {", "            Some(t) if !self.stale(t) => Some(t),", "            _ => None,", "        }", "    }", ""],
        ["    fn stale(&self, t: &CachedTopic) -> bool {", "        t.fetched_at.elapsed() > self.ttl", "    }", ""],
        ["    pub async fn refresh(&mut self, id: u64) -> Result<(), FetchError> {", "        let fresh = fetch_topic(id).await?;", "        self.entries.insert(id, fresh);", "        Ok(())", "    }", ""],
        ["#[derive(Debug, Clone, Copy)]", "pub enum ViewMode {", "    List,", "    Detail { topic_id: u64 },", "    Split { topic_id: u64, panel: PanelKind },", "}", ""],
        ["// 分页按每页 N 楼切分，页边界只在读取时计算一次", "const PAGE_SIZE: usize = 20;", ""],
        ["pub struct PageCursor {", "    offset: usize,", "    limit: usize,", "}", "", "impl PageCursor {", "    pub fn slice<'a, T>(&self, all: &'a [T]) -> &'a [T] {", "        let end = (self.offset + self.limit).min(all.len());", "        &all[self.offset.min(end)..end]", "    }", "}", ""],
        ["#[derive(Debug)]", "pub enum FetchError {", "    Timeout(Duration),", "    Status(u16),", "    Decode(String),", "}", "", "impl std::fmt::Display for FetchError {", "    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {", "        write!(f, \"fetch failed: {:?}\", self)", "    }", "}", ""],
        ["#[cfg(test)]", "mod tests {", "    use super::*;", "", "    #[test]", "    fn expired_entry_is_dropped() {", "        let mut c = TopicCache::new(Duration::from_secs(0));", "        c.entries.insert(1, CachedTopic::default());", "        assert!(c.get(1).is_none());", "    }", "}", ""]
      ]
    },
    python: {
      label: "Python", file: "crawler.py", dir: "workers", icon: "PY", comment: "#",
      renames: [["queue", "work_queue"], ["offset", "start"], ["limit", "page_size"], ["seen", "visited"], ["attempt", "retry"]],
      kw: ["def", "class", "return", "if", "else", "elif", "for", "while", "in", "import", "from", "as", "with", "try", "except", "finally", "raise", "lambda", "None", "True", "False", "async", "await", "yield", "pass", "self", "is", "not", "and", "or"],
      blocks: [
        ["import asyncio", "import hashlib", "from dataclasses import dataclass, field", "from typing import Optional", ""],
        ["@dataclass", "class TopicSnapshot:", "    topic_id: int", "    title: str", "    replies: list = field(default_factory=list)", "    fetched_at: float = 0.0", ""],
        ['class Crawler:', '    """列表 -> 详情 -> 分页。分页边界只在读取时算一次。"""', "", "    def __init__(self, workers: int = 8):", "        self.workers = workers", "        self.queue: asyncio.Queue = asyncio.Queue(maxsize=1024)", "        self.seen: set[int] = set()", ""],
        ["    async def run(self) -> None:", "        producers = [asyncio.create_task(self.produce(i)) for i in range(2)]", "        consumers = [asyncio.create_task(self.consume(i)) for i in range(self.workers)]", "        await asyncio.gather(*producers, *consumers)", ""],
        ["    async def consume(self, idx: int) -> None:", "        while True:", "            snap = await self.queue.get()", "            try:", "                await self.persist(snap)", "            except Exception as exc:", '                logger.warning("persist failed: %s", exc)', "            finally:", "                self.queue.task_done()", ""],
        ["    def fingerprint(self, snap: TopicSnapshot) -> str:", "        digest = hashlib.sha256(snap.title.encode()).hexdigest()", "        return digest[:16]", ""],
        ["    async def page_count(self, topic_id: int, per_page: int = 20) -> int:", "        total = await self.fetch_reply_count(topic_id)", "        return max(1, -(-total // per_page))", ""],
        ["def backoff(attempt: int, base: float = 0.5) -> float:", "    # 指数退避 + 抖动，避免触发站点限流", "    return base * (2 ** attempt) * (0.5 + random.random())", ""],
        ["class FetchError(RuntimeError):", '    """把网络/解析错误分开，方便上层决定要不要重试。"""', "", "    def __init__(self, kind: str, detail: str = \"\"):", "        super().__init__(f\"{kind}: {detail}\")", "        self.kind = kind", "        self.detail = detail", ""],
        ["@dataclass", "class PageCursor:", "    offset: int = 0", "    limit: int = 20", "", "    def slice(self, rows: list) -> list:", "        end = min(self.offset + self.limit, len(rows))", "        return rows[self.offset:end]", ""],
        ["async def fetch_topic(topic_id: int, retries: int = 3) -> TopicSnapshot:", "    for attempt in range(retries):", "        try:", "            return await _get(f\"/topic/{topic_id}\")", "        except FetchError as exc:", "            if attempt == retries - 1:", "                raise", "            await asyncio.sleep(backoff(attempt))", ""],
        ["async def main() -> None:", "    crawler = Crawler(workers=16)", "    await crawler.run()", "", 'if __name__ == "__main__":', "    asyncio.run(main())", ""]
      ]
    },
    typescript: {
      label: "TypeScript", file: "app.ts", dir: "web", icon: "TS", comment: "//",
      renames: [["cache", "store"], ["ttl", "ttlMs"], ["offset", "start"], ["expiresAt", "expiresAtMs"], ["attempt", "retry"]],
      kw: ["const", "let", "var", "function", "return", "if", "else", "for", "of", "in", "while", "import", "from", "export", "default", "class", "extends", "interface", "type", "enum", "new", "this", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "readonly", "public", "private", "void", "string", "number", "boolean", "Promise", "Map", "Set"],
      blocks: [
        ['import { EventEmitter } from "events";', 'import type { Topic, Reply } from "./types";', ""],
        ["interface CacheEntry<T> {", "  value: T;", "  expiresAt: number;", "}", ""],
        ["export class TopicStore extends EventEmitter {", "  private cache = new Map<number, CacheEntry<Topic>>();", "  private readonly ttl = 30_000;", "", "  constructor(private readonly client: ApiClient) {", "    super();", "  }", ""],
        ["  async get(id: number): Promise<Topic | null> {", "    const hit = this.cache.get(id);", "    if (hit && hit.expiresAt > Date.now()) return hit.value;", "    const fresh = await this.client.fetchTopic(id);", "    this.cache.set(id, { value: fresh, expiresAt: Date.now() + this.ttl });", '    this.emit("update", fresh);', "    return fresh;", "  }", ""],
        ["  async replies(id: number, page: number): Promise<Reply[]> {", "    // 分页边界只在读取时计算一次", "    return this.client.fetchReplies(id, page);", "  }", ""],
        ["  invalidate(id?: number): void {", "    if (id === undefined) this.cache.clear();", "    else this.cache.delete(id);", "  }", ""],
        ["  slice<T>(all: readonly T[], offset: number, limit: number): T[] {", "    const end = Math.min(offset + limit, all.length);", "    return all.slice(Math.min(offset, end), end);", "  }", ""],
        ["export function renderRow(topic: Topic): string {", '  const tag = topic.node ? `[${topic.node.name}]` : "";', "  return `${tag} ${topic.title} (${topic.replies} 回复)`;", "}", ""],
        ["export class FetchError extends Error {", "  constructor(readonly kind: \"timeout\" | \"status\" | \"decode\", detail = \"\") {", "    super(`${kind}: ${detail}`);", "    this.name = \"FetchError\";", "  }", "}", ""],
        ["export async function fetchTopic(id: number, retries = 3): Promise<Topic> {", "  for (let attempt = 0; attempt < retries; attempt++) {", "    try {", "      return await client.fetchTopic(id);", "    } catch (err) {", "      if (attempt === retries - 1) throw err;", "      await sleep(backoff(attempt));", "    }", "  }", "  throw new Error(\"unreachable\");", "}", ""],
        ["type ViewState =", '  | { kind: "idle" }', '  | { kind: "loading" }', '  | { kind: "ready"; replies: Reply[] }', '  | { kind: "error"; message: string };', ""],
        ["export function reduce(state: ViewState, ev: ViewEvent): ViewState {", "  switch (ev.type) {", '    case "load": return { kind: "loading" };', '    case "ok":   return { kind: "ready", replies: ev.replies };', '    case "err":  return { kind: "error", message: ev.message };', "    default:     return state;", "  }", "}", ""]
      ]
    },
    go: {
      label: "Go", file: "main.go", dir: "cmd", icon: "GO", comment: "//",
      renames: [["entries", "store"], ["ttl", "ttlNanos"], ["Offset", "Start"], ["Limit", "PageSize"]],
      kw: ["func", "package", "import", "return", "if", "else", "for", "range", "go", "chan", "select", "case", "default", "type", "struct", "interface", "map", "var", "const", "defer", "nil", "err", "string", "int", "bool", "error", "true", "false"],
      blocks: [
        ["package main", "", "import (", '    "context"', '    "fmt"', '    "sync"', '    "time"', ")", ""],
        ["type TopicCache struct {", "    mu      sync.RWMutex", "    entries map[uint64]CachedTopic", "    ttl     time.Duration", "}", ""],
        ["func NewTopicCache(ttl time.Duration) *TopicCache {", "    return &TopicCache{entries: make(map[uint64]CachedTopic), ttl: ttl}", "}", ""],
        ["func (c *TopicCache) Get(id uint64) (CachedTopic, bool) {", "    c.mu.RLock()", "    defer c.mu.RUnlock()", "    t, ok := c.entries[id]", "    if !ok || t.Expired(c.ttl) {", "        return CachedTopic{}, false", "    }", "    return t, true", "}", ""],
        ["func (c *TopicCache) Refresh(ctx context.Context, id uint64) error {", "    fresh, err := FetchTopic(ctx, id)", "    if err != nil {", '        return fmt.Errorf("refresh topic %d: %w", id, err)', "    }", "    c.mu.Lock()", "    defer c.mu.Unlock()", "    c.entries[id] = fresh", "    return nil", "}", ""],
        ["// 分页边界只在读取时计算一次", "const pageSize = 20", "", "func TotalPages(replies int) int {", "    if replies <= pageSize {", "        return 1", "    }", "    return (replies + pageSize - 1) / pageSize", "}", ""],
        ["type PageCursor struct {", "    Offset int", "    Limit  int", "}", "", "func (c PageCursor) Slice(all []CachedTopic) []CachedTopic {", "    end := c.Offset + c.Limit", "    if end > len(all) {", "        end = len(all)", "    }", "    return all[c.Offset:end]", "}", ""],
        ["type FetchError struct {", "    Kind   string", "    Detail string", "}", "", "func (e *FetchError) Error() string {", '    return fmt.Sprintf("fetch %s: %s", e.Kind, e.Detail)', "}", ""],
        ["func main() {", "    ctx, cancel := context.WithCancel(context.Background())", "    defer cancel()", "    cache := NewTopicCache(30 * time.Second)", '    fmt.Println("listening on :8080")', "}", ""]
      ]
    },
    java: {
      label: "Java", file: "TopicService.java", dir: "src/main/java", icon: "JV", comment: "//",
      renames: [["cache", "store"], ["ttl", "ttlNanos"], ["offset", "start"], ["limit", "pageSize"]],
      kw: ["public", "private", "protected", "class", "interface", "enum", "static", "final", "void", "return", "if", "else", "for", "while", "new", "this", "import", "package", "extends", "implements", "try", "catch", "finally", "throw", "throws", "int", "long", "boolean", "String", "List", "Map", "Optional", "var"],
      blocks: [
        ["package com.example.app;", "", "import java.time.Duration;", "import java.util.Map;", "import java.util.Optional;", "import java.util.concurrent.ConcurrentHashMap;", ""],
        ["public class TopicService {", "", "    private final Map<Long, CachedTopic> cache = new ConcurrentHashMap<>();", "    private final Duration ttl;", "    private final TopicClient client;", ""],
        ["    public TopicService(TopicClient client, Duration ttl) {", "        this.client = client;", "        this.ttl = ttl;", "    }", ""],
        ["    public Optional<CachedTopic> get(long id) {", "        CachedTopic hit = cache.get(id);", "        if (hit == null || hit.expired(ttl)) {", "            return Optional.empty();", "        }", "        return Optional.of(hit);", "    }", ""],
        ["    public CachedTopic refresh(long id) throws FetchException {", "        CachedTopic fresh = client.fetchTopic(id);", "        cache.put(id, fresh);", "        return fresh;", "    }", ""],
        ["    // 分页边界只在读取时计算一次", "    public int totalPages(int replies, int perPage) {", "        return replies <= perPage ? 1 : (replies + perPage - 1) / perPage;", "    }", ""],
        ["    public <T> List<T> slice(List<T> all, int offset, int limit) {", "        int end = Math.min(offset + limit, all.size());", "        return all.subList(Math.min(offset, end), end);", "    }", ""],
        ["    public static class FetchException extends Exception {", "        private final String kind;", "", "        public FetchException(String kind, String detail) {", "            super(kind + \": \" + detail);", "            this.kind = kind;", "        }", "", "        public String kind() { return kind; }", "    }", ""],
        ["    public CacheStats stats() {", "        return new CacheStats(cache.size(), hits.get(), misses.get());", "    }", "}", ""]
      ]
    }
  };

  /** 迷你语法高亮（字符串 → 转义 → 关键字/数字/类型 → 注释） */
  function highlightCode(line, L) {
    let s = line, cm = "";
    const ci = s.indexOf(L.comment);
    if (ci >= 0) { cm = s.slice(ci); s = s.slice(0, ci); }

    /*
     * 先把字符串字面量抠出来存着，避免里面的内容被后面的关键字/数字规则误伤。
     *
     * 占位符必须**不含数字**。
     * 这一个 bug 是从参考脚本继承来的，原来的占位符是 "\u0001<序号>\u0002"，
     * 紧接着的「数字高亮」会把占位符里的序号当成数字包成 <span class="tk-n">…</span>，
     * 于是还原正则再也匹配不到：字符串整段消失、正文里漏出裸的控制字符，
     * 页面上看起来就是一串乱码（比如 fmt.Errorf 里只剩一个红框 %d）。
     * 现在改成「重复 N 个 \u0001 + 一个 \u0002」：没有数字，任何规则都咬不到它；
     * 而且靠 \u0002 收尾，相邻占位符也不会粘成一片。
     */
    const slots = [];
    const stash = (m) => { slots.push(m); return "\u0001".repeat(slots.length) + "\u0002"; };
    s = s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
      (m) => stash('<span class="tk-s">' + escapeHtml(m) + "</span>"));
    s = escapeHtml(s);
    s = s.replace(new RegExp("\\b(" + L.kw.join("|") + ")\\b", "g"), '<span class="tk-k">$1</span>');
    s = s.replace(/\b(\d[\d_]*(?:\.\d+)?)\b/g, '<span class="tk-n">$1</span>');
    s = s.replace(/\b([A-Z][A-Za-z0-9]+)\b/g, '<span class="tk-t">$1</span>');
    // 还原：\u0001 的个数 - 1 就是 slots 下标
    s = s.replace(/\u0001+\u0002/g, (m) => slots[m.length - 2] || "");
    if (cm) s += '<span class="tk-c">' + escapeHtml(cm) + "</span>";
    return s;
  }

  /**
   * 生成假代码。
   *
   * 关键：**每个 block 只输出一次**，而且按作者写好的顺序拼。
   * 早前的实现是「随机抽 block 直到凑够 150 行」——结果同一个 `pub struct`
   * 会连着重复四五次，任何人扫一眼就知道这块是假的。
   * 代码面板是伪装的一部分，先得像真的，所以宁可固定成「同一个文件」。
   * （需要有随机感的是 diff 模式，那条路径仍按 seed 生成加/删行。）
   */
  function genCodeLines(langKey) {
    const L = CODE_LANGS[langKey] || CODE_LANGS.rust;
    const out = [];
    for (const b of L.blocks) out.push(...b);
    return out;
  }

  function getLang() {
    const v = cfg("lang");
    return CODE_LANGS[v] ? v : "rust";
  }

  function getCodeMode() {
    return cfg("codeMode") === "diff" ? "diff" : "code";
  }

  function panelHidden() {
    return !cfg("codePanel");
  }

  function setPanelHidden(hidden, persist) {
    const main = document.querySelector(".hpcx-main");
    if (!main) return;
    main.classList.toggle("panel-hidden", hidden);
    if (persist) {
      setCfg("codePanel", !hidden, { visualOnly: true });
      syncSettingControls();
    }
  }

  /** 面板种子：详情 = 帖子 id；列表 = 路径字符串哈希 */
  function panelSeed() {
    const r = route();
    if (r.kind === "thread" && r.tid) return num(r.tid) | 0;
    const s = r.path + (r.base || "");
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  function renderCodePanel() {
    const main = document.querySelector(".hpcx-main");
    if (!main) return;
    const L = CODE_LANGS[getLang()];
    const mode = getCodeMode();
    const seed = panelSeed();
    const r = route();

    const iconEl = main.querySelector("[data-code-icon]");
    const fileEl = main.querySelector("[data-code-file-name]");
    if (iconEl) iconEl.textContent = L.icon;
    if (fileEl) fileEl.textContent = L.file;

    const setSeg = (sel, text) => {
      const n = main.querySelector(sel);
      if (n) n.textContent = text;
    };
    setSeg("[data-code-crumb-root]", L.root || cfg("projectName"));
    setSeg("[data-code-crumb-cat]", r.kind === "thread" ? "topics" : "feeds");
    setSeg("[data-code-crumb-dir]", r.kind === "thread" ? "detail" : L.dir);
    setSeg("[data-code-crumb-file]", L.file);

    const langLabel = main.querySelector("[data-lang-label]");
    if (langLabel) langLabel.textContent = L.label;

    const tabs = main.querySelectorAll(".hpcx-code-tab");
    if (tabs[1]) tabs[1].classList.toggle("on", mode === "diff");
    if (tabs[0]) tabs[0].classList.toggle("on", mode === "code");

    const menu = main.querySelector("[data-lang-menu]");
    if (menu) {
      menu.innerHTML = Object.entries(CODE_LANGS).map(([k, v]) =>
        '<div class="' + (k === getLang() ? "on" : "") + '" data-code-lang-item="' + k + '">' +
        "<span>" + escapeHtml(v.label) + "</span>" +
        '<span style="color:var(--cx-text-faint)">' + escapeHtml(v.file) + "</span>" +
        "</div>").join("");
    }

    const body = main.querySelector("[data-code-body]");
    if (!body) return;
    const lines = genCodeLines(getLang());

    let html = "";
    if (mode === "diff") {
      /*
       * 装饰性 diff。
       *
       * 不能像早前那样「把原行后面拼个 _patched();」—— 会出来
       *   `import ( _patched();`  /  `defer c.mu.Unlock()_patched();`
       * 这种一眼假的玩意。
       * 这里改成「标识符重命名」：删掉一行，再补上把某个标识符改过名的同一行。
       * 这是纯文本替换，不可能生成语法上离谱的东西，而且看起来就像一个真 refactor。
       */
      const rnd = mulberry32((seed * 7919 + 13) | 0);
      const renames = L.renames || [];
      // 整页只做一个重命名（而不是逐行随机）—— 真的 refactor 是全文件一致的，
      // 逐行随机会出现一半用 entries、一半用 cache 的四不像。
      const pair = renames.length ? renames[Math.floor(rnd() * renames.length)] : null;
      const re = pair ? new RegExp("\\b" + pair[0] + "\\b", "g") : null;
      let ln = 1;
      lines.forEach((line, i) => {
        if (i % 14 === 0) {
          html += '<div class="hpcx-code-line hunk"><span class="hpcx-ln"></span>' +
            '<span class="hpcx-src">@@ -' + ln + ",6 +" + ln + ',7 @@</span></div>';
        }
        const to = re ? line.replace(re, pair[1]) : line;
        if (re && to !== line) {
          html += '<div class="hpcx-code-line del"><span class="hpcx-ln">' + ln +
            '</span><span class="hpcx-src">' + highlightCode(line, L) + "</span></div>";
          html += '<div class="hpcx-code-line add"><span class="hpcx-ln">' + ln +
            '</span><span class="hpcx-src">' + highlightCode(to, L) + "</span></div>";
          ln++;
          return;
        }
        html += '<div class="hpcx-code-line"><span class="hpcx-ln">' + ln +
          '</span><span class="hpcx-src">' + highlightCode(line, L) + "</span></div>";
        ln++;
      });
    } else {
      lines.forEach((line, i) => {
        html += '<div class="hpcx-code-line"><span class="hpcx-ln">' + (i + 1) +
          '</span><span class="hpcx-src">' + highlightCode(line, L) + "</span></div>";
      });
    }
    body.innerHTML = html;
    body.scrollTop = 0;
    setPanelHidden(panelHidden(), false);
    syncTitle();
    if (bossOn()) renderBoss();
  }

  /* ============================== 点亮 / 取消点亮 ==============================
   *
   * 接口同样是从站点 JS 里读出来的（回帖列表组件里的“亮了”按钮）：
   *
   *   POST /pcmapi/pc/bbs/v1/reply/light        点亮
   *   POST /pcmapi/pc/bbs/v1/reply/cancelLight  取消
   *
   * body：{ pid, tid, puid, fid, deviceId }
   * 注意几点：
   *   · 四个 id 在站点代码里都做了 `+` 强转，也就是发**数字**
   *   · puid 是**当前登录用户**的 puid（不是被点亮那楼的作者）
   *   · deviceId 又是数美那个设备号
   * ====================================================================== */

  /** 拼点亮接口的 body（纯函数，好断言） */
  function buildLightPayload(thread, pid, deviceId) {
    return {
      pid: Number(pid) || 0,
      tid: Number(thread.tid) || 0,
      puid: Number(thread.myPuid) || 0,
      fid: Number(thread.fid) || 0,
      deviceId: String(deviceId == null ? "" : deviceId)
    };
  }

  /** 按站点的成功判定：200 / "200" / 1 都算成功 */
  function isApiOk(res) {
    const c = res && res.code;
    return c === 200 || c === 1 || c === "200" || (res && res.status === 200);
  }

  async function toggleLight(btn) {
    const d = PAGE && PAGE.data;
    if (!d || !PAGE.route || PAGE.route.kind !== "thread") return;
    if (loginState() === false) { toastNow("需要登录才能点亮"); return; }

    const pid = btn.dataset.pid || "";
    if (!pid) { toastNow("拿不到这一楼的 id"); return; }

    const wasLit = btn.dataset.lit === "1";
    const url = wasLit ? "/pcmapi/pc/bbs/v1/reply/cancelLight" : "/pcmapi/pc/bbs/v1/reply/light";
    btn.disabled = true;

    try {
      const resp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildLightPayload(d, pid, currentShumeiId()))
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const res = await resp.json().catch(() => ({}));

      if (isApiOk(res)) {
        // 本地先把状态和数字改掉，不用整页重刷
        const lit = !wasLit;
        btn.dataset.lit = lit ? "1" : "0";
        btn.classList.toggle("on", lit);
        const label = btn.querySelector("span");
        if (label) label.textContent = lit ? "已亮" : "亮";
        const turn = btn.closest(".hpcx-turn");
        const num = turn && turn.querySelector("[data-light-count]");
        if (num) num.textContent = String(Math.max(0, (Number(num.textContent) || 0) + (lit ? 1 : -1)));
        toastNow(lit ? "已点亮" : "已取消点亮");
      } else {
        toastNow(replyErrorText(res));
      }
    } catch (err) {
      toastNow("点亮失败：" + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
    }
  }

  /* ============================== 发新帖 ==============================
   *
   * 原生页面底部的「前往发帖」指向 /post/<topicId>，而 /post/... 是**服务端登录门**
   * （未登录直接 302 到 passport），所以拿不到那个页面的 JS，接口只能靠探：
   *
   *   POST /pcmapi/pc/bbs/v1/createThread
   *     {}                 → PC022002「帖子内容不能为空」（接口存在，且认 content）
   *     {"content":"..."}  → PC022003「用户未登录」（内容过了，轮到登录门）
   *   对照：一堆不存在的路径都只会回通用的 AS021999 风控提示。
   *
   * 字段名来自站点自己的编辑器代码（动态 chunk reply-compact-editor）：
   *   default 分支 e = { nonce, title, cateId }，再合并公共的
   *   { fid, topicId, content, shumeiId, video* }。
   *
   * 注意：**成功路径没能实测**（没账号，而且探多了会被阿里云 WAF 拦），
   * 所以弹框里额外留了「去原生页面发帖」这条退路。
   * ====================================================================== */

  /** 拼发帖 body（纯函数，好断言） */
  function buildThreadPayload(board, title, html, shumeiId) {
    return {
      fid: String(board.fid || ""),
      topicId: String(board.topicId || ""),
      cateId: String(board.cateId || ""),
      title: String(title == null ? "" : title).trim(),
      content: String(html == null ? "" : html),
      nonce: "",
      shumeiId: String(shumeiId == null ? "" : shumeiId),
      videoCover: "",
      videoUrl: "",
      videoSource: "",
      videoPreview: ""
    };
  }

  /** 当前页面的版块信息（只有版块列表页才有） */
  function publishBoard() {
    const d = PAGE && PAGE.data;
    return d && d.board && d.board.topicId ? d.board : null;
  }

  function closePublish() {
    const m = document.querySelector(".hpcx-publish");
    if (m) m.hidden = true;
  }

  function publishOpen() {
    const m = document.querySelector(".hpcx-publish");
    return !!m && !m.hidden;
  }

  function openPublish() {
    if (loginState() === false) { toastNow("需要登录才能发帖"); return; }
    const board = publishBoard();
    if (!board) { toastNow("这个页面没有版块信息，去原生页面发帖吧"); return; }

    let m = document.querySelector(".hpcx-publish");
    if (!m) {
      m = el("div", "hpcx-publish");
      m.hidden = true;
      m.setAttribute("data-hpcx", "");
      m.innerHTML =
        '<div class="hpcx-publish-card">' +
        '<div class="hpcx-publish-head">' +
        '<span class="hpcx-publish-title">发新帖</span>' +
        '<span class="hpcx-publish-board" data-pub-board></span>' +
        '<button type="button" class="hpcx-modal-x" data-pub-close title="关闭（Esc）">×</button>' +
        "</div>" +
        '<div class="hpcx-publish-body">' +
        '<input class="hpcx-publish-input" data-pub-title type="text" maxlength="60" ' +
        'placeholder="标题（必填）" autocomplete="off">' +
        '<textarea class="hpcx-publish-text" data-pub-content rows="8" ' +
        'placeholder="正文…支持 **加粗**、`代码`、> 引用、- 列表"></textarea>' +
        '<div class="hpcx-publish-status" data-pub-status></div>' +
        "</div>" +
        '<div class="hpcx-publish-foot">' +
        '<span class="hpcx-dim">发布后会跳到新帖</span>' +
        '<a class="hpcx-modal-btn" data-pub-native target="_blank" rel="noopener">去原生页面发帖</a>' +
        '<button type="button" class="hpcx-send" data-pub-submit>' + ic("send") + "<span>发布</span></button>" +
        "</div></div>";
      document.body.appendChild(m);
    }

    m.querySelector("[data-pub-board]").textContent = board.name || "版块";
    m.querySelector("[data-pub-native]").href = HOME + "/post/" + board.topicId;
    const st = m.querySelector("[data-pub-status]");
    if (st) st.textContent = "";
    m.hidden = false;
    const input = m.querySelector("[data-pub-title]");
    if (input) input.focus();
  }

  async function submitThread() {
    const m = document.querySelector(".hpcx-publish");
    if (!m) return;
    const board = publishBoard();
    if (!board) { toastNow("拿不到版块信息"); return; }

    const titleEl = m.querySelector("[data-pub-title]");
    const textEl = m.querySelector("[data-pub-content]");
    const st = m.querySelector("[data-pub-status]");
    const btn = m.querySelector("[data-pub-submit]");
    const title = (titleEl.value || "").trim();
    const raw = (textEl.value || "").trim();

    const fail = (msg) => { if (st) { st.textContent = msg; st.dataset.kind = "err"; } toastNow(msg); };
    if (!title) { fail("标题不能为空"); titleEl.focus(); return; }
    if (!raw) { fail("正文不能为空"); textEl.focus(); return; }

    const oldLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = ic("clock") + "<span>发布中…</span>";
    if (st) { st.textContent = "正在发布…"; st.dataset.kind = ""; }

    try {
      const resp = await fetch("/pcmapi/pc/bbs/v1/createThread", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildThreadPayload(board, title, draftToHtml(raw), currentShumeiId()))
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const res = await resp.json().catch(() => ({}));

      if (isApiOk(res)) {
        const url = res.data && (res.data.url || (res.data.jumpDTO && res.data.jumpDTO.url));
        if (st) { st.textContent = "发布成功"; st.dataset.kind = "ok"; }
        toastNow("发布成功" + (url ? " · 正在跳转" : " · 刷新可见"));
        if (url) setTimeout(() => { location.href = url; }, 600);
        else closePublish();
      } else {
        fail(replyErrorText(res));
      }
    } catch (err) {
      fail("发布失败：" + (err && err.message ? err.message : err));
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldLabel;
    }
  }

  function bindPublish() {
    if (bindPublish._bound) return;
    bindPublish._bound = true;
    // 弹框里的 Ctrl/Cmd+Enter = 发布（和回帖输入框的习惯保持一致）
    document.addEventListener("keydown", (e) => {
      if (!publishOpen()) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        submitThread();
      }
    }, true);
  }

  /* ============================== 发表回复 ==============================
   *
   * 接口是从站点自己的 JS 里挖出来的（动态 chunk `reply-compact-editor`）：
   *
   *   POST /pcmapi/pc/bbs/v1/createReply
   *   Content-Type: application/json
   *   credentials: include（凭 session cookie，不需要额外 token）
   *
   * body 字段（对照它源码里那个 post 对象）：
   *   fid / topicId / content / tid        必填
   *   pid + data.atc_content               楼中楼（回复某一层）时才带
   *   quoteId                              来自 ?quoteId= 参数（高级回复页用）
   *   shumeiId / video*                    反欺诈设备号与视频字段，纯文字回复给空值
   *
   * 返回 { code, message }：code === 200 或 1 算成功。
   * ====================================================================== */

  /** 当前正在回复的楼层（点某楼的「回复」时设置） */
  let REPLY_TARGET = null;

  /**
   * 拼接口要的 body。
   *
   * 单独抽成纯函数，方便直接断言字段名 —— 这类接口最容易把 tid/fid
   * 写反或者漏字段，而报错信息往往只有一句「参数错误」。
   */
  function buildReplyPayload(thread, html, target, quoteId, shumeiId) {
    const content = String(html == null ? "" : html);
    const base = {
      fid: String(thread.fid || ""),
      topicId: String(thread.topicId || ""),
      content,
      videoCover: "",
      videoUrl: "",
      videoSource: "",
      videoPreview: "",
      shumeiId: String(shumeiId == null ? "" : shumeiId),
      tid: String(thread.tid || ""),
      quoteId: String(quoteId || "")
    };
    if (!target || !target.pid) return base;
    // 楼中楼：带 pid，并把被引用那一楼的原文放进 data.atc_content
    return Object.assign({}, base, {
      pid: String(target.pid),
      data: { atc_content: String(target.contentHtml || content) }
    });
  }

  /** 把草稿（纯文本 + 极简 markdown）转成站内编辑器产出的那种 HTML */
  function draftToHtml(text) {
    const src = String(text == null ? "" : text).trim();
    if (!src) return "";
    // mdToHtml 本来就会输出 <p> / <strong> / <code> / <blockquote> / <ul> / <a>
    return mdToHtml(src);
  }

  /**
   * 把接口返回翻成一句人话。
   *
   * 实测这个接口失败时回的是 `msg`（不是 `message`），例如
   *   {"code":0,"internalCode":"PC022003","msg":"用户未登录"}
   *   {"code":0,"internalCode":"AS021999","msg":"内容数据出现异常，请稍后再试试"}
   * 两个字段都认，拿不到再按 code 兜底。
   */
  function replyErrorText(res) {
    const code = res && res.code;
    const msg = (res && (res.msg || res.message)) || "";
    if (msg) return msg;
    if (code === 401 || code === 403) return "需要登录（或登录已过期）";
    if (code === 4005 || code === 400) return "内容不合法或为空";
    return "发送失败（code " + code + "）";
  }

  /**
   * 数美（Shumei）反欺诈设备号。
   *
   * 站点自己就是 `SMSdk.getDeviceId()`，拿不到才退回空串；
   * 页面会加载 smDeviceSdk2.js 把 window.SMSdk 挂上去。
   * 实测不带这个东西直接 POST，会被风控拦下来并回
   *   { code:0, internalCode:"AS021999", msg:"内容数据出现异常" }
   * —— 所以能拿就拿，拿不到也不编。
   */
  function currentShumeiId() {
    try {
      const s = window.SMSdk;
      if (s && typeof s.getDeviceId === "function") {
        const v = s.getDeviceId();
        return v == null ? "" : String(v);
      }
    } catch { /* SDK 没加载 / 报错都不影响发帖 */ }
    return "";
  }

  async function submitReply() {
    const d = PAGE && PAGE.data;
    if (!d || !PAGE.route || PAGE.route.kind !== "thread") {
      toastNow("只有在帖子详情页才能回帖");
      return;
    }
    if (loginState() === false) { toastNow("未登录，先登录再回帖"); return; }

    const edit = composerEditor();
    if (!edit) return;
    const raw = (edit.textContent || "").trim();
    if (!raw) { toastNow("内容为空"); return; }
    const html = draftToHtml(raw);
    if (!html) { toastNow("内容为空"); return; }

    const btn = document.querySelector('.hpcx-send[data-md="reply"]');
    const oldLabel = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = ic("clock") + "<span>发送中…</span>"; }
    setStatus("正在发送…", "");

    try {
      const quoteId = new URLSearchParams(location.search).get("quoteId") || "";
      const resp = await fetch("/pcmapi/pc/bbs/v1/createReply", {
        method: "POST",
        credentials: "include",          // 靠 cookie 认证，不用自己攒 token
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildReplyPayload(d, html, REPLY_TARGET, quoteId, currentShumeiId()))
      });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const res = await resp.json().catch(() => ({}));
      const code = res && res.code;
      if (code === 200 || code === 1) {
        edit.textContent = "";
        REPLY_TARGET = null;
        renderReplyTarget();
        syncComposerState();
        setStatus("发送成功", "ok");
        toastNow("回复成功 · 刷新可见" + (d.totalPages > 1 ? "（新回复在最后一页）" : ""));
      } else {
        setStatus("发送失败", "err");
        toastNow(replyErrorText(res));
      }
    } catch (err) {
      setStatus("发送失败", "err");
      toastNow("发送失败：" + (err && err.message ? err.message : err));
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = oldLabel; }
    }
  }

  /* ============================== 底部草稿板 ==============================
   *
   * 编辑区是 contenteditable，但内容按「纯文本 + \n」维护：
   * 容器 white-space: pre-wrap，所以 \n 就是换行，
   * 所有编辑操作都能在字符串上做，不用处理 contenteditable 那套脏 DOM。
   *
   * 草稿按帖子 id 存 localStorage（换页回来还在），
   * 登录状态下点「回复」会真的走接口发表（见上面「发表回复」）。
   * ===================================================================== */

  function composerEditor() {
    return document.querySelector(".hpcx-main .hpcx-editor");
  }

  function draftKey() {
    const r = route();
    return r.kind === "thread" ? DRAFT_PREFIX + r.tid : DRAFT_PREFIX + "scratch";
  }

  function loadDraft() {
    try { return localStorage.getItem(draftKey()) || ""; } catch { return ""; }
  }

  function saveDraft(text) {
    try {
      if (text) localStorage.setItem(draftKey(), text);
      else localStorage.removeItem(draftKey());
    } catch { /* ignore */ }
  }

  function setStatus(text, kind) {
    const el = document.querySelector(".hpcx-main [data-composer-status]");
    if (!el) return;
    el.textContent = text || "";
    el.dataset.kind = kind || "";
  }

  /**
   * 草稿框顶部那一行：平时显示「Re：标题」，
   * 点了某楼的「回复」后换成「回复 @xxx · 第 N 楼 ✕」，✕ 取消引用。
   */
  function renderReplyTarget() {
    const box = document.querySelector(".hpcx-main .hpcx-composer-target");
    if (!box) return;
    const t = REPLY_TARGET;
    const d = PAGE && PAGE.data;
    if (!t) {
      const title = d ? "Re：" + d.title : "草稿本";
      box.innerHTML = escapeHtml(title);
      box.title = title;
      box.classList.remove("quoting");
      return;
    }
    box.classList.add("quoting");
    box.innerHTML = ic("reply") + "<span>回复 " + escapeHtml(t.author || "该楼层") +
      "（" + escapeHtml(String(t.floor)) + " 楼）</span>" +
      '<button type="button" class="hpcx-quote-cancel" data-md="cancel-quote" title="取消引用">×</button>';
    box.title = "将作为楼中楼回复该楼层";
  }

  function syncComposerState() {
    const main = document.querySelector(".hpcx-main");
    if (!main) return;
    const edit = main.querySelector(".hpcx-editor");
    const status = main.querySelector("[data-composer-status]");
    if (!edit) return;
    const src = edit.textContent || "";
    saveDraft(src);
    if (status && !status.dataset.busy) {
      const chars = src.length;
      const canSend = loginState() !== false && PAGE && PAGE.route && PAGE.route.kind === "thread";
      status.textContent = chars
        ? chars + " 字 · " + (canSend ? "Ctrl+Enter 发表" : "Ctrl+Enter 复制草稿")
        : (canSend ? "Ctrl+Enter 发表 · 草稿只存本机" : "本地草稿 · 只存在你自己浏览器里");
    }
    const preview = main.querySelector("[data-composer-preview]");
    if (preview && !preview.hidden) preview.innerHTML = mdToHtml(src);
  }

  function syncComposer(page) {
    const wrap = document.querySelector(".hpcx-main .hpcx-composer-wrap");
    if (!wrap) return;
    const r = page.route;
    const isThread = r.kind === "thread";

    // 只在换了帖子（或换了页面类型）时重建，避免打字打到一半被刷掉
    const stamp = r.kind + ":" + (r.tid || r.path);
    if (wrap.dataset.stamp === stamp) { syncComposerState(); return; }
    wrap.dataset.stamp = stamp;

    const target = isThread && page.data
      ? "Re：" + page.data.title
      : r.kind === "list"
        ? "（列表页 · 这里是随手记的草稿本）"
        : "草稿本";

    /*
     * 能不能真发表，看登录态度：
     *   true  已登录 → 给「回复」按钮，Ctrl+Enter 直接发
     *   false 未登录 → 只能复制草稿，提示去登录
     *   null  不知道 → 给按钮，点了由接口告诉结果（总比默认说“不能发”好）
     */
    const canPost = isThread && loginState() !== false;

    wrap.innerHTML =
      '<div class="hpcx-composer">' +
      '<div class="hpcx-composer-head">' +
      '<span class="hpcx-composer-target" title="' + escapeHtml(target) + '">' + escapeHtml(target) + "</span>" +
      '<span class="hpcx-composer-hint">' +
      (canPost ? "Ctrl+Enter 发表"
        // 列表页本来就不能回帖，别把原因说成「未登录」
        : isThread ? "未登录 · 仅本地草稿" : "随手记 · 只存本机") + "</span>" +
      "</div>" +
      '<div class="hpcx-editor" contenteditable="true" spellcheck="false" ' +
      'data-placeholder="' + (canPost ? "写点什么…（Ctrl+Enter 发表）" : "写点什么…（未登录，Ctrl+Enter 复制草稿）") + '"></div>' +
      '<div class="hpcx-composer-preview" data-composer-preview hidden></div>' +
      '<div class="hpcx-composer-bar">' +
      '<div class="hpcx-ct-group">' +
      '<button class="hpcx-ct-btn" data-md="bold" title="加粗 **text**">' + ic("bold") + "</button>" +
      '<button class="hpcx-ct-btn" data-md="italic" title="斜体 *text*">' + ic("italic") + "</button>" +
      '<button class="hpcx-ct-btn" data-md="quote" title="引用 > text">' + ic("quote") + "</button>" +
      '<button class="hpcx-ct-btn" data-md="code" title="行内代码 `x`">' + ic("code") + "</button>" +
      '<button class="hpcx-ct-btn" data-md="list" title="无序列表">' + ic("list") + "</button>" +
      '<button class="hpcx-ct-btn" data-md="link" title="链接">' + ic("link") + "</button>" +
      "</div>" +
      '<div class="hpcx-ct-group">' +
      '<button class="hpcx-ct-btn" data-md="preview" title="预览 markdown">' + ic("eye") + "</button>" +
      '<button class="hpcx-ct-btn" data-md="clear" title="清空草稿">' + ic("trash") + "</button>" +
      "</div>" +
      '<span class="hpcx-composer-status" data-composer-status></span>' +
      (canPost
        ? '<button class="hpcx-send" data-md="reply" title="发表回复（Ctrl+Enter）">' +
          ic("send") + "<span>回复</span></button>"
        : isThread
          ? '<a class="hpcx-send ghost" href="' + LOGIN_URL + '" target="_blank" rel="noreferrer" title="登录后可直接回帖">' +
            ic("user") + "<span>登录后回帖</span></a>"
          // 列表页没有可回复的对象，就别摆一个回帖按钮
          : "") +
      '<button class="hpcx-send ghost" data-md="copy" title="复制草稿">' + ic("copy") + "<span>复制</span></button>" +
      (isThread ? '<a class="hpcx-send ghost" href="' + escapeHtml(location.href) + '" target="_blank" rel="noopener">' +
        ic("external") + "<span>原生回帖</span></a>" : "") +
      "</div>" +
      "</div>";

    const edit = wrap.querySelector(".hpcx-editor");
    edit.textContent = loadDraft();
    renderReplyTarget();
    syncComposerState();
  }

  function setCaret(node, offset) {
    try {
      const range = document.createRange();
      const sel = window.getSelection();
      const text = node.firstChild;
      if (!text) {
        range.selectNodeContents(node);
      } else {
        const o = Math.max(0, Math.min(offset, text.textContent.length));
        range.setStart(text, o);
        range.collapse(true);
      }
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* ignore */ }
  }

  function mdApply(fn) {
    const edit = composerEditor();
    if (!edit) return;
    edit.focus();
    const src = edit.textContent || "";
    const sel = window.getSelection();
    let start = src.length, end = src.length;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (edit.contains(r.startContainer)) {
        const pre = document.createRange();
        pre.selectNodeContents(edit);
        pre.setEnd(r.startContainer, r.startOffset);
        start = pre.toString().length;
        const pre2 = document.createRange();
        pre2.selectNodeContents(edit);
        pre2.setEnd(r.endContainer, r.endOffset);
        end = pre2.toString().length;
      }
    }
    const out = fn(src, start, end);
    edit.textContent = out.text;
    setCaret(edit, out.caret);
    syncComposerState();
  }

  function wrapSel(before, after) {
    return mdApply((src, a, b) => {
      const sel = src.slice(a, b);
      return { text: src.slice(0, a) + before + sel + after + src.slice(b), caret: a + before.length + sel.length };
    });
  }

  /** 极简 markdown → HTML（只支持草稿里写得出来的那几种，够预览用） */
  function mdToHtml(src) {
    const esc = escapeHtml(src);
    const lines = esc.split("\n");
    const out = [];
    let inList = false;
    const inline = (s) => s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) {
        if (!inList) { out.push("<ul>"); inList = true; }
        out.push("<li>" + inline(li[1]) + "</li>");
        continue;
      }
      if (inList) { out.push("</ul>"); inList = false; }
      if (/^&gt;\s?/.test(line)) { out.push("<blockquote>" + inline(line.replace(/^&gt;\s?/, "")) + "</blockquote>"); continue; }
      if (!line) { out.push(""); continue; }
      out.push("<p>" + inline(line) + "</p>");
    }
    if (inList) out.push("</ul>");
    return out.join("\n") || '<span class="hpcx-dim">（空）</span>';
  }

  function bindComposer(main) {
    // 编辑事件（委托，因为 composer 会被重建）
    main.addEventListener("input", (e) => {
      if (e.target.closest(".hpcx-editor")) syncComposerState();
    });
    main.addEventListener("keydown", (e) => {
      const edit = e.target.closest(".hpcx-editor");
      if (!edit) return;      // Enter 保留为换行，Ctrl/Cmd+Enter 才是「发表」；未登录时退化成复制草稿
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        if (loginState() !== false && PAGE && PAGE.route && PAGE.route.kind === "thread") {
          submitReply();
        } else {
          copyText(edit.textContent || "");
        }
      }
    });
    main.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-md]");
      if (!btn) return;
      const kind = btn.dataset.md;
      if (kind === "bold") wrapSel("**", "**");
      else if (kind === "italic") wrapSel("*", "*");
      else if (kind === "code") wrapSel("`", "`");
      else if (kind === "quote") mdApply((src, a) => {
        const lineStart = src.lastIndexOf("\n", a - 1) + 1;
        return { text: src.slice(0, lineStart) + "> " + src.slice(lineStart), caret: a + 2 };
      });
      else if (kind === "list") mdApply((src, a) => {
        const lineStart = src.lastIndexOf("\n", a - 1) + 1;
        return { text: src.slice(0, lineStart) + "- " + src.slice(lineStart), caret: a + 2 };
      });
      else if (kind === "link") wrapSel("[", "](https://)");
      else if (kind === "clear") {
        const edit = composerEditor();
        if (edit) { edit.textContent = ""; syncComposerState(); }
        toastNow("草稿已清空");
      } else if (kind === "preview") {
        const p = main.querySelector("[data-composer-preview]");
        if (p) {
          p.hidden = !p.hidden;
          if (!p.hidden) p.innerHTML = mdToHtml(composerEditor()?.textContent || "");
        }
      } else if (kind === "copy") {
        copyText(composerEditor()?.textContent || "");
      } else if (kind === "reply") {
        submitReply();
      } else if (kind === "cancel-quote") {
        REPLY_TARGET = null;
        renderReplyTarget();
      }
    });
  }

  /* ============================== 三栏拖拽调宽 ============================== */

  function bindResizers(main) {
    let drag = null;

    const onDown = (e) => {
      const handle = e.target.closest("[data-resize]");
      if (!handle) return;
      e.preventDefault();
      const kind = handle.dataset.resize;
      drag = { kind, startX: e.clientX, start: kind === "rail" ? cfg("railWidth") : cfg("panelWidth") };
      document.documentElement.classList.add("hpcx-resizing");
    };
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      // panel 在右侧，往左拖是变宽
      const next = Math.round(drag.start + (drag.kind === "rail" ? dx : -dx));
      const min = drag.kind === "rail" ? 200 : 240;
      const max = drag.kind === "rail" ? 520 : 900;
      const v = Math.max(min, Math.min(max, next));
      const varName = drag.kind === "rail" ? "--cx-rail-w" : "--hpcx-panel-w";
      document.documentElement.style.setProperty(varName, v + "px");
      drag.value = v;
    };
    const onUp = () => {
      if (!drag) return;
      document.documentElement.classList.remove("hpcx-resizing");
      if (drag.value != null) {
        setCfg(drag.kind === "rail" ? "railWidth" : "panelWidth", drag.value, { visualOnly: true });
        syncSettingControls();
      }
      drag = null;
    };
    // 双击复位
    const onDbl = (e) => {
      const handle = e.target.closest("[data-resize]");
      if (!handle) return;
      setCfg(handle.dataset.resize === "rail" ? "railWidth" : "panelWidth",
        handle.dataset.resize === "rail" ? RAIL_W : PANEL_DEFAULT_W, { visualOnly: true });
      syncSettingControls();
    };

    if (bindResizers._bound) return;
    bindResizers._bound = true;
    document.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("dblclick", onDbl);
  }

  /* ============================== 图片：缩略图 + 灯箱 + 悬浮预览 ============================== */

  let lightboxOpen = false;

  function closeLightbox() {
    document.querySelector(".hpcx-lightbox")?.remove();
    lightboxOpen = false;
  }

  function openLightbox(src, alt) {
    closeLightbox();
    const box = el("div", "hpcx-lightbox");
    box.setAttribute("data-hpcx", "");
    box.innerHTML = '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt || "") + '">' +
      '<span class="hpcx-lightbox-x" title="关闭（Esc）">×</span>';
    box.addEventListener("click", (e) => {
      if (e.target === box || e.target.closest(".hpcx-lightbox-x")) closeLightbox();
    });
    document.body.appendChild(box);
    lightboxOpen = true;
  }

  function bindLightbox() {
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && lightboxOpen) {
        e.preventDefault();
        e.stopPropagation();
        closeLightbox();
      }
      // 引用卡片 / 思考块 / 亮评区的折叠
      const chev = e.target.closest && e.target.closest(".hpcx-think-head, .hpcx-quote-head, .hpcx-lights-head");
      if (chev && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        if (chev.classList.contains("hpcx-lights-head")) chev.parentElement.classList.toggle("collapsed");
        else chev.parentElement.classList.toggle("open");
      }
    }, true);

    document.addEventListener("click", (e) => {
      // 发新帖弹框
      if (e.target.closest("[data-publish]")) { e.preventDefault(); openPublish(); return; }
      if (e.target.closest("[data-pub-close]")) { e.preventDefault(); closePublish(); return; }
      if (e.target.closest("[data-pub-submit]")) { e.preventDefault(); submitThread(); return; }
      if (e.target === document.querySelector(".hpcx-publish")) { closePublish(); return; }

      // 亮评区单独处理：它折的是自己（.collapsed），不是 .open
      const lightsHead = e.target.closest("[data-lights-toggle]");
      if (lightsHead) {
        e.preventDefault();
        const box = lightsHead.closest(".hpcx-lights");
        if (box) box.classList.toggle("collapsed");
        return;
      }
      const head = e.target.closest(".hpcx-think-head, .hpcx-quote-head");
      if (head && !e.target.closest("[data-jump-floor]")) {
        head.parentElement.classList.toggle("open");
        return;
      }
      const act = e.target.closest(".hpcx-act[data-act]");
      if (act) { handleTurnAction(act); return; }
      const img = e.target.closest(".hpcx-cooked img, .hpcx-turn-user-bubble img, .hpcx-quote-body img");
      if (img) {
        e.preventDefault();
        openLightbox(img.dataset.origin || img.src, img.alt);
      }
    });
  }

  /**
   * 给图片补上缩略图该有的东西。
   *
   * 这里**故意不做「小图另给一套尺寸」** —— max-width / max-height 本来就是上限，
   * 小图不会被拉大，不需要额外分支；
   * 而那种分支一旦写死像素值，就会把用户在设置里调的尺寸架空
   * （之前那个 180px 的 hpcx-img-sm 就是这么把表情图变成“不听话”的）。
   */
  function prepareContentImages(root) {
    root.querySelectorAll("img").forEach((img) => {
      if (img.complete && img.naturalWidth === 0) return;   // 交给失败兜底
      img.loading = "lazy";
      img.decoding = "async";
    });
  }

  let imgPreviewEl = null;
  let imgPreviewTarget = null;   // 当前预览对应的缩略图（防止旧图的 load 回调乱定位）
  let imgPreviewTimer = null;

  /**
   * 图片加载失败的处理。
   *
   * 虎扑的图存在图床防盗链 / 过期的问题，直接让它挂着会在正文里
   * 留一个带边框的破图占位符，很难看。这里换成一条可点的提示，
   * 点开就是原图地址（content 里的 data-origin），信息不丢。
   *
   * 注意：img 的 error 事件不冒泡，所以要用捕获阶段监听。
   */
  function bindImgFallback() {
    if (bindImgFallback._bound) return;
    bindImgFallback._bound = true;
    document.addEventListener("error", (e) => {
      const img = e.target;
      if (!img || img.tagName !== "IMG" || img.dataset.fallbackDone === "1") return;
      const inLightbox = !!img.closest(".hpcx-lightbox");
      if (!inLightbox && !img.closest(".hpcx-main, .hpcx-rail")) return;
      img.dataset.fallbackDone = "1";

      if (inLightbox) { closeLightbox(); toastNow("原图加载失败"); return; }

      const url = img.dataset.origin || img.currentSrc || img.src || "";
      const a = document.createElement("a");
      a.className = "hpcx-img-fallback";
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "图片加载失败 · 点这里看原图";
      a.title = url;
      img.replaceWith(a);
    }, true);
  }

  function ensureImgPreview() {
    if (imgPreviewEl) return imgPreviewEl;
    imgPreviewEl = el("div", "hpcx-imgprev");
    imgPreviewEl.innerHTML = '<img alt="">';
    imgPreviewEl.setAttribute("data-hpcx", "");
    document.body.appendChild(imgPreviewEl);
    return imgPreviewEl;
  }

  /** 预览框的最大允许尺寸（要和 CSS 里的 42vw / 52vh 保持一致） */
  function previewCaps() {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    return { maxW: Math.min(vw * 0.42, vw - 24), maxH: Math.min(vh * 0.52, vh - 24), vw, vh };
  }

  /**
   * 大图还没下载完时，按缩略图的宽高比估一个尺寸。
   * 不估的话盒子会塌成 0×0，getBoundingClientRect() 全是 0，
   * 定位就会把它摆到视口左上角去（或者看起来“没动”）。
   */
  function estimatePreviewSize(anchor) {
    const { maxW, maxH } = previewCaps();
    const nw = anchor.naturalWidth || 0;
    const nh = anchor.naturalHeight || 0;
    if (!nw || !nh) return { w: Math.round(maxW * 0.6), h: Math.round(maxH * 0.5) };
    const k = Math.min(1, maxW / nw, maxH / nh);
    return { w: Math.max(96, Math.round(nw * k)), h: Math.max(72, Math.round(nh * k)) };
  }

  /**
   * 把预览框摆到图片旁边：优先右侧，右边放不下换左侧，
   * 都放不下就夹在视口内；重直方向跟图片对齐并夹进视口。
   * 坐标是视口系的，所以用 getBoundingClientRect() 而不是 offsetLeft。
   */
  function placeImgPreview(anchor) {
    const box = imgPreviewEl;
    if (!box || !anchor || !anchor.isConnected) return;
    const a = anchor.getBoundingClientRect();
    const p = box.getBoundingClientRect();
    const gap = 12;
    const { vw, vh } = previewCaps();

    // 水平：右侧优先
    let left = a.right + gap;
    if (left + p.width > vw - gap) left = a.left - gap - p.width;   // 换左侧
    if (left < gap) {
      // 两边都放不下（图很宽 / 预览很大）→ 夹在视口内
      left = Math.max(gap, Math.min(vw - p.width - gap, a.right + gap));
    }

    // 重直：与图片中线对齐，再夹进视口
    let top = a.top + (a.height - p.height) / 2;
    top = Math.max(gap, Math.min(vh - p.height - gap, top));

    box.style.left = Math.round(left) + "px";
    box.style.top = Math.round(top) + "px";
  }

  function showImgPreview(anchor) {
    if (!cfg("thumbPreview")) return;
    const url = anchor.dataset.origin || anchor.currentSrc || anchor.src;
    if (!url) return;

    const box = ensureImgPreview();
    const big = box.querySelector("img");
    if (big.getAttribute("src") !== url) big.setAttribute("src", url);
    imgPreviewTarget = anchor;

    // 大图未到位时先用缩略图的比例占位，让第一次定位就是对的
    const pending = !big.complete || !big.naturalWidth;
    if (pending) {
      const e = estimatePreviewSize(anchor);
      big.style.width = e.w + "px";
      big.style.height = e.h + "px";
      big.style.objectFit = "contain";
    } else {
      big.style.width = "";
      big.style.height = "";
      big.style.objectFit = "";
    }

    box.classList.add("on");
    placeImgPreview(anchor);

    if (pending) {
      big.addEventListener("load", () => {
        if (imgPreviewTarget !== anchor) return;
        // 图到齐了，改回自然尺寸（仍受 max 限制），再校正一次位置
        big.style.width = "";
        big.style.height = "";
        big.style.objectFit = "";
        placeImgPreview(anchor);
      }, { once: true });
      big.addEventListener("error", () => {
        if (imgPreviewTarget === anchor) hideImgPreview();
      }, { once: true });
    }
  }

  function hideImgPreview() {
    imgPreviewTarget = null;
    if (imgPreviewEl) imgPreviewEl.classList.remove("on");
  }

  function bindImgPreview() {
    if (bindImgPreview._bound) return;
    bindImgPreview._bound = true;
    const isContentImg = (t) => t && t.closest && t.closest(".hpcx-cooked img, .hpcx-turn-user-bubble img");

    // 用捕获阶段：img 没有子节点，每个 img 只会触发一次 mouseover
    document.addEventListener("mouseover", (e) => {
      const img = isContentImg(e.target);
      if (!img) return;
      clearTimeout(imgPreviewTimer);
      showImgPreview(img);
    }, true);

    document.addEventListener("mouseout", (e) => {
      if (!isContentImg(e.target)) return;
      clearTimeout(imgPreviewTimer);
      // 留一点延迟：鼠标在图与图之间移动时会先 out 再 over，
      // 立刻收起会闪一下
      imgPreviewTimer = setTimeout(hideImgPreview, 70);
    }, true);

    // 滚动 / 失焦 / 切标签页时 fixed 预览会和缩略图错位，直接收起
    document.addEventListener("scroll", hideImgPreview, true);
    window.addEventListener("blur", hideImgPreview);
    document.addEventListener("visibilitychange", hideImgPreview);
    // 窗口尺寸变了要重新夹一次位置，否则可能跑到视口外
    window.addEventListener("resize", () => {
      if (imgPreviewEl && imgPreviewEl.classList.contains("on") && imgPreviewTarget) {
        placeImgPreview(imgPreviewTarget);
      }
    });
  }

  /* ============================== 明暗模式 ============================== */

  function themeOverride() {
    const t = cfg("theme");
    if (t === "light" || t === "dark") return t;
    return null;
  }

  function isDarkMode() {
    const want = themeOverride();
    if (want) return want === "dark";
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return true;
    }
  }

  function syncMode() {
    document.documentElement.classList.toggle(LIGHT_CLASS, !isDarkMode());
    syncModeBtn();
  }

  function syncModeBtn() {
    const btn = document.querySelector(".hpcx-mode-btn");
    if (btn) btn.innerHTML = isDarkMode() ? ic("sun") : ic("moon");
  }

  /* ============================== CSS ============================== */

  // 视觉 token 对齐 Codex 桌面 app；组件一律引用变量，明暗共用一套规则。
  const RAW_CSS = String.raw`
    /* ---------- Token：深色（默认） ---------- */
    html.${ROOT_CLASS} {
      --cx-rail-bg: #1d272c;
      --cx-rail-bg-hover: #26343a;
      --cx-rail-bg-active: #2d3d45;
      --cx-rail-text: #f5f8f9;
      --cx-rail-text-dim: #dfe7ea;
      --cx-rail-text-faint: #b0babe;
      --cx-rail-border: rgba(255, 255, 255, 0.06);

      --cx-bg: #181818;
      --cx-bg-raised: #242424;
      --cx-bg-inset: #1c1c1c;
      --cx-bg-deep: #161616;
      --cx-panel-bg: #181818;
      --cx-composer-bg: #2a2a2a;

      --cx-border: rgba(255, 255, 255, 0.08);
      --cx-border-soft: rgba(255, 255, 255, 0.05);
      --cx-border-strong: rgba(255, 255, 255, 0.14);
      --cx-text: #ececec;
      --cx-text-secondary: #b9b9b9;
      --cx-text-dim: #909090;
      --cx-text-faint: #646464;

      --cx-blue: #83c3fe;
      --cx-blue-soft: rgba(131, 195, 254, 0.15);
      --cx-chip-bg: #2e2e2e;
      --cx-chip-text: #ececec;
      --cx-btn-hover: #333333;
      --cx-wash: rgba(255, 255, 255, 0.03);
      --cx-scroll-thumb: rgba(255, 255, 255, 0.12);
      --cx-send-bg: #8a8a8a;
      --cx-send-icon: #1f1f1f;
      --cx-accent: #d97757;

      --cx-code-text: #cfcfcf;
      --cx-code-gutter: #707070;
      --cx-tok-k: #f0954e;
      --cx-tok-s: #78cf70;
      --cx-tok-c: #6f7a6f;
      --cx-tok-t: #b06dff;
      --cx-tok-n: #64b5e0;
      --cx-diff-add-bg: rgba(64, 201, 119, 0.10);
      --cx-diff-del-bg: rgba(250, 66, 62, 0.09);
      --cx-diff-hunk-bg: rgba(131, 195, 254, 0.07);

      --cx-font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      --cx-font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas,
        "Liberation Mono", monospace;

      --cx-rail-w: ${RAIL_W}px;
      --hpcx-panel-w: ${PANEL_DEFAULT_W}px;
      --hpcx-thread-max: 860px;
      --hpcx-thumb-w: 300px;
      --hpcx-thumb-h: 200px;
      --cx-radius: 10px;
    }

    /* ---------- Token：浅色 ---------- */
    html.${ROOT_CLASS}.${LIGHT_CLASS} {
      --cx-rail-bg: #e4eaeb;
      --cx-rail-bg-hover: #d9e1e3;
      --cx-rail-bg-active: #ced8da;
      --cx-rail-text: #14191b;
      --cx-rail-text-dim: #333a3d;
      --cx-rail-text-faint: #41494c;
      --cx-rail-border: rgba(0, 0, 0, 0.07);

      --cx-bg: #f4f4f4;
      --cx-bg-raised: #ffffff;
      --cx-bg-inset: #fafafa;
      --cx-bg-deep: #ebebeb;
      --cx-panel-bg: #ffffff;
      --cx-composer-bg: #ffffff;

      --cx-border: rgba(0, 0, 0, 0.10);
      --cx-border-soft: rgba(0, 0, 0, 0.06);
      --cx-border-strong: rgba(0, 0, 0, 0.16);
      --cx-text: #1b1c1e;
      --cx-text-secondary: #55565a;
      --cx-text-dim: #737477;
      --cx-text-faint: #a2a3a5;

      --cx-blue: #2a98ff;
      --cx-blue-soft: rgba(42, 152, 255, 0.13);
      --cx-chip-bg: #ededed;
      --cx-chip-text: #1b1c1e;
      --cx-btn-hover: #e6e6e6;
      --cx-wash: rgba(0, 0, 0, 0.04);
      --cx-scroll-thumb: rgba(0, 0, 0, 0.18);
      --cx-send-bg: #3c3c3c;
      --cx-send-icon: #ffffff;
      --cx-accent: #c2603f;

      --cx-code-text: #26282b;
      --cx-code-gutter: #8a8b8f;
      --cx-tok-k: #aa3d00;
      --cx-tok-s: #1c7d28;
      --cx-tok-c: #8a9086;
      --cx-tok-t: #8a40d0;
      --cx-tok-n: #2a62c9;
      --cx-diff-add-bg: rgba(23, 160, 88, 0.10);
      --cx-diff-del-bg: rgba(230, 60, 55, 0.10);
      --cx-diff-hunk-bg: rgba(42, 152, 255, 0.08);
    }

    /* ---------- 盒模型 ---------- */
    .hpcx-rail, .hpcx-rail *, .hpcx-main, .hpcx-main *,
    .hpcx-lightbox, .hpcx-lightbox *, .hpcx-toast, .hpcx-boss, .hpcx-boss *,
    .hpcx-modal, .hpcx-modal *, .hpcx-imgprev, .hpcx-imgprev * { box-sizing: border-box; }

    /* ---------- 隐藏原生页面（接管中 / 启动判定中） ----------
     *
     * 不能只藏 #container / #__next！
     * 虎扑用的 rc-menu / antd 那套会把下拉弹层渲染成 **body 直接子节点**（portal），
     * 那些节点在 #container 外面；而且它们自带 inline 的 visibility:visible，
     * 用 visibility 层层盖也不一定盖得住。
     * 实际现象就是启动时主区里浮现「登录后的世界更精彩」「综合体育」这种残片。
     *
     * 所以改成最雨不透风的写法：凡是不是我们自己的 body 子节点，一律 display:none。
     * 我们自己挂到 body 的东西都带 data-hpcx 标记（rail / main / 弹层 / toast …）。
     * 这份规则 BOOT 和 LOCK 共用 —— 两个状态对「原生内容该不该占布局」的诉求一样：
     * 都不该。区别只是 BOOT 还可能反悔（判定为不支持时摘掉）。
     */
    html.${ROOT_CLASS}.${LOCK_CLASS} #container,
    html.${ROOT_CLASS}.${LOCK_CLASS} #__next,
    html.${ROOT_CLASS}.${LOCK_CLASS} body > *:not([data-hpcx]),
    html.${ROOT_CLASS}.${BOOT_CLASS} #container,
    html.${ROOT_CLASS}.${BOOT_CLASS} #__next,
    html.${ROOT_CLASS}.${BOOT_CLASS} body > *:not([data-hpcx]) {
      display: none !important;
    }
    html.${ROOT_CLASS}.${LOCK_CLASS} body {
      margin: 0 !important;
      min-width: 0 !important;
      background: var(--cx-bg) !important;
      color: var(--cx-text) !important;
      overflow-x: hidden;
    }
    /* 启动中也要先把底色刷上，别闪白 */
    html.${ROOT_CLASS}.${BOOT_CLASS} body {
      margin: 0 !important;
      background: var(--cx-bg) !important;
      color: var(--cx-text) !important;
    }
    /* 未接管的原生页面（搜索 / 登录…）：rail 常驻，原生内容右移 */
    html.${ROOT_CLASS}:not(.${LOCK_CLASS}) #container,
    html.${ROOT_CLASS}:not(.${LOCK_CLASS}) #__next {
      margin-left: var(--cx-rail-w) !important;
    }

    /* ================= 左 rail ================= */
    .hpcx-rail {
      position: fixed;
      left: 0; top: 0; bottom: 0;
      width: var(--cx-rail-w);
      background: var(--cx-rail-bg);
      color: var(--cx-rail-text);
      border-right: 1px solid var(--cx-rail-border);
      display: flex; flex-direction: column;
      z-index: 2147483000;
      font-family: var(--cx-font-ui);
      font-size: 13px;
      transition: transform .22s ease;
    }
    .hpcx-rail-traffic {
      height: 38px; flex: 0 0 auto;
      display: flex; align-items: center; gap: 8px;
      padding: 0 12px;
    }
    .hpcx-rail-traffic > span {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 6px;
      color: var(--cx-rail-text-faint); cursor: pointer;
    }
    .hpcx-rail-traffic > span:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .hpcx-rail-traffic svg { width: 16px; height: 16px; }

    .hpcx-rail-brand {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 6px;
      padding: 2px 12px 10px;
    }
    .hpcx-rail-brand-name {
      flex: 1 1 auto; min-width: 0;
      display: inline-flex; align-items: center; gap: 4px;
      color: var(--cx-rail-text); text-decoration: none;
      font-size: 14.5px; font-weight: 600; letter-spacing: .1px;
      padding: 4px 6px; margin-left: -6px; border-radius: 7px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .hpcx-rail-brand-name:hover { background: var(--cx-rail-bg-hover); }
    .hpcx-rail-brand-name svg { width: 14px; height: 14px; opacity: .7; }
    .hpcx-rail-brand-actions { display: flex; align-items: center; gap: 2px; }
    .hpcx-rail-brand-actions > span {
      width: 26px; height: 26px; border-radius: 7px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--cx-rail-text-faint); cursor: pointer;
    }
    .hpcx-rail-brand-actions > span:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .hpcx-rail-brand-actions svg { width: 15px; height: 15px; }

    .hpcx-rail-scroll {
      flex: 1 1 auto; overflow-y: auto; overflow-x: hidden;
      padding: 0 8px 12px;
      scrollbar-width: thin;
      scrollbar-color: var(--cx-scroll-thumb) transparent;
    }
    .hpcx-rail-scroll::-webkit-scrollbar { width: 8px; }
    .hpcx-rail-scroll::-webkit-scrollbar-thumb {
      background: var(--cx-scroll-thumb); border-radius: 4px;
      border: 2px solid transparent; background-clip: content-box;
    }

    .hpcx-rail-nav { display: flex; flex-direction: column; gap: 1px; margin-bottom: 6px; }
    .hpcx-rail-section {
      display: flex; align-items: center; justify-content: space-between;
      gap: 6px;
      padding: 14px 10px 5px;
      font-size: 11px; font-weight: 600; letter-spacing: .5px;
      text-transform: uppercase;
      color: var(--cx-rail-text-faint);
    }
    .hpcx-more {
      font-size: 10.5px; font-weight: 500; letter-spacing: 0;
      text-transform: none; cursor: pointer;
      color: var(--cx-rail-text-faint);
      padding: 1px 6px; border-radius: 5px;
    }
    .hpcx-more:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    /* 纯说明文字（“共 20 页”这种），别长成能点的样子 */
    .hpcx-note {
      font-size: 10.5px; font-weight: 500; letter-spacing: 0;
      text-transform: none; cursor: default;
      color: var(--cx-rail-text-faint);
      padding: 1px 6px;
    }
    .hpcx-rail-section-items { display: flex; flex-direction: column; gap: 1px; }

    .hpcx-rail-item {
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; border-radius: 7px;
      color: var(--cx-rail-text-dim); text-decoration: none;
      font-size: 13px; line-height: 1.35;
      min-width: 0;
    }
    .hpcx-rail-item > svg { width: 15px; height: 15px; flex: 0 0 auto; opacity: .72; }
    .hpcx-rail-item:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .hpcx-rail-item.active {
      background: var(--cx-rail-bg-active); color: var(--cx-rail-text); font-weight: 600;
    }
    .hpcx-rail-item.active > svg { opacity: 1; }
    .hpcx-rail-item.hint { color: var(--cx-rail-text); }
    .hpcx-label {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hpcx-count {
      flex: 0 0 auto; font-size: 11px; font-variant-numeric: tabular-nums;
      color: var(--cx-rail-text-faint);
      background: var(--cx-rail-bg-hover);
      padding: 1px 6px; border-radius: 999px;
    }
    .hpcx-rail-item.active .hpcx-count { background: rgba(127,127,127,.28); color: var(--cx-rail-text); }

    .hpcx-cat { display: flex; flex-direction: column; }
    .hpcx-cat-chev {
      width: 18px; height: 18px; border-radius: 5px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--cx-rail-text-faint);
    }
    .hpcx-cat-chev svg { width: 12px; height: 12px; transition: transform .16s ease; }
    .hpcx-cat-chev:hover { background: var(--cx-rail-bg-active); color: var(--cx-rail-text); }
    .hpcx-cat.open > .hpcx-cat-head .hpcx-cat-chev svg { transform: rotate(90deg); }
    .hpcx-cat-body { display: none; flex-direction: column; gap: 1px; padding-left: 10px; }
    .hpcx-cat.open > .hpcx-cat-body { display: flex; }

    .hpcx-rail-foot {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid var(--cx-rail-border);
    }
    .hpcx-rail-foot-user {
      flex: 1 1 auto; min-width: 0;
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px; border-radius: 7px;
      color: var(--cx-rail-text-dim); text-decoration: none; font-size: 12.5px;
    }
    .hpcx-rail-foot-user:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .hpcx-rail-foot-user svg { width: 15px; height: 15px; opacity: .75; flex: 0 0 auto; }
    .hpcx-mode-btn {
      width: 30px; height: 30px; flex: 0 0 auto;
      border: 0; border-radius: 8px; cursor: pointer;
      background: transparent; color: var(--cx-rail-text-faint);
      display: inline-flex; align-items: center; justify-content: center;
    }
    .hpcx-mode-btn:hover { background: var(--cx-rail-bg-hover); color: var(--cx-rail-text); }
    .hpcx-mode-btn svg { width: 16px; height: 16px; }

    .hpcx-resizer {
      position: absolute; top: 0; right: -3px; bottom: 0; width: 6px;
      cursor: col-resize; z-index: 5;
    }
    .hpcx-resizer:hover { background: var(--cx-blue-soft); }
    html.hpcx-resizing { cursor: col-resize !important; user-select: none; }
    html.hpcx-resizing * { cursor: col-resize !important; }

    /* ================= 主区 ================= */
    .hpcx-main {
      margin-left: var(--cx-rail-w);
      min-height: 100vh;
      display: grid;
      grid-template-columns: minmax(0, 1fr) var(--hpcx-panel-w);
      background: var(--cx-bg);
      color: var(--cx-text);
      font-family: var(--cx-font-ui);
      font-size: 14px;
    }
    .hpcx-main.panel-hidden { grid-template-columns: minmax(0, 1fr) 0; }
    .hpcx-main.panel-hidden .hpcx-code-col { display: none; }

    .hpcx-thread-col {
      min-width: 0;
      display: flex; flex-direction: column;
      height: 100vh;
    }
    .hpcx-topbar {
      flex: 0 0 auto;
      height: 46px;
      display: flex; align-items: center; gap: 2px;
      padding: 0 12px;
      border-bottom: 1px solid var(--cx-border-soft);
      background: var(--cx-bg);
    }
    .hpcx-icon-btn {
      width: 30px; height: 30px; border-radius: 8px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--cx-text-dim); cursor: pointer;
      border: 0; background: transparent; text-decoration: none;
      flex: 0 0 auto;
    }
    .hpcx-icon-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-icon-btn svg { width: 16px; height: 16px; }
    .hpcx-menu-btn { display: none; }
    .hpcx-crumb {
      display: flex; align-items: center; gap: 6px;
      margin-left: 6px; min-width: 0; font-size: 12.5px;
    }
    .hpcx-proj { color: var(--cx-text); font-weight: 600; flex: 0 0 auto; }
    .hpcx-sep { color: var(--cx-text-faint); }
    .hpcx-model {
      color: var(--cx-text-dim); min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hpcx-spacer { flex: 1 1 auto; }

    .hpcx-thread {
      flex: 1 1 auto; overflow-y: auto; overflow-x: hidden;
      scrollbar-width: thin; scrollbar-color: var(--cx-scroll-thumb) transparent;
    }
    .hpcx-thread::-webkit-scrollbar { width: 10px; }
    .hpcx-thread::-webkit-scrollbar-thumb {
      background: var(--cx-scroll-thumb); border-radius: 5px;
      border: 3px solid transparent; background-clip: content-box;
    }
    .hpcx-thread-inner {
      max-width: var(--hpcx-thread-max);
      margin: 0 auto;
      padding: 20px 26px 40px;
    }

    /* ================= 标题区 ================= */
    /* （原来那块「专区信息」大卡片已删，它的样式 .hpcx-card* 一并清掉；
       .hpcx-card-links / .hpcx-pill 还用在别处，保留） */
    .hpcx-card-links { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .hpcx-pill {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 9px; border-radius: 999px;
      background: var(--cx-chip-bg); color: var(--cx-chip-text);
      font-size: 11.5px; text-decoration: none; border: 0; cursor: pointer;
      max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hpcx-pill:hover { background: var(--cx-btn-hover); }
    .hpcx-pill.on { background: var(--cx-blue-soft); color: var(--cx-blue); }

    .hpcx-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; margin: 6px 0 10px;
    }
    .hpcx-head-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
    /* 帖数不能把版块名挤没：名字可截断，胶囊保持完整 */
    .hpcx-head-title > .hpcx-pill { flex: 0 0 auto; }
    .hpcx-head-title h1 {
      margin: 0; font-size: 15px; font-weight: 650;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hpcx-filter-btn {
      width: 26px; height: 26px; border-radius: 7px; border: 0;
      background: transparent; color: var(--cx-text-dim); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .hpcx-filter-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-filter-btn svg { width: 15px; height: 15px; }
    .hpcx-new-topic-btn {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px; border-radius: 8px; border: 0;
      background: var(--cx-chip-bg); color: var(--cx-chip-text);
      font-size: 12.5px; text-decoration: none; cursor: pointer; flex: 0 0 auto;
    }
    .hpcx-new-topic-btn:hover { background: var(--cx-btn-hover); }
    .hpcx-new-topic-btn svg { width: 14px; height: 14px; }
    .hpcx-head-desc { color: var(--cx-text-dim); font-size: 12.5px; margin-bottom: 12px; }
    .hpcx-filter-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
    .hpcx-fchip {
      padding: 4px 11px; border-radius: 999px;
      background: transparent; color: var(--cx-text-secondary);
      border: 1px solid var(--cx-border);
      font-size: 12px; text-decoration: none; cursor: pointer;
    }
    .hpcx-fchip:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-fchip.on { background: var(--cx-blue-soft); color: var(--cx-blue); border-color: transparent; font-weight: 600; }
    .hpcx-fchip.ghost { border-color: transparent; cursor: default; }

    /* ================= 列表行 ================= */
    .hpcx-rows { display: flex; flex-direction: column; }
    .hpcx-row {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 10px; border-radius: 9px;
      text-decoration: none; color: inherit;
      min-width: 0;
    }
    .hpcx-row:hover { background: var(--cx-wash); }
    .hpcx-row-avatar {
      width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
      background: var(--cx-text-faint); opacity: .5;
    }
    .hpcx-row-avatar.hot { background: var(--cx-accent); opacity: .9; }
    .hpcx-row-texts { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .hpcx-row-title {
      font-size: 13.5px; color: var(--cx-text); line-height: 1.45;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .hpcx-row-sub {
      display: flex; flex-wrap: wrap; gap: 8px;
      font-size: 11.5px; color: var(--cx-text-faint);
    }
    .hpcx-node { color: var(--cx-text-secondary); }
    .hpcx-row-meta {
      flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
      font-size: 11.5px; color: var(--cx-text-faint);
      font-variant-numeric: tabular-nums;
    }
    /* 列表行里的「N 亮」：只是强调色文本，不要底色也不要边框。
       注意别用 .hpcx-lights —— 那个类是详情页亮评卡片的，
       一旦重名，列表行会沾上卡片的底色 / 边框 / 内边距。 */
    .hpcx-row-lights { color: var(--cx-accent); }
    .hpcx-row-sep { height: 1px; background: var(--cx-border-soft); margin: 2px 0 2px 17px; }

    /* ================= agent 装饰 ================= */
    .hpcx-think {
      margin: 7px 0 5px 17px;
      border-left: 2px solid var(--cx-border);
      padding-left: 10px;
    }
    .hpcx-think-head {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; color: var(--cx-text-dim); cursor: pointer;
      user-select: none;
    }
    .hpcx-think-head:hover { color: var(--cx-text); }
    .hpcx-spin { display: inline-flex; color: var(--cx-text-faint); }
    .hpcx-spin svg { width: 13px; height: 13px; }
    .hpcx-think-chev {
      width: 0; height: 0; margin-left: 2px;
      border-left: 4px solid currentColor;
      border-top: 3.5px solid transparent;
      border-bottom: 3.5px solid transparent;
      transition: transform .15s ease;
    }
    .hpcx-think.open .hpcx-think-chev { transform: rotate(90deg); }
    .hpcx-think-body {
      display: none;
      margin-top: 5px;
      font-size: 12.5px; line-height: 1.7;
      color: var(--cx-text-dim); white-space: pre-wrap;
      font-family: var(--cx-font-ui);
    }
    .hpcx-think.open .hpcx-think-body { display: block; }

    .hpcx-runline {
      display: flex; align-items: center; gap: 7px;
      margin: 5px 0 5px 17px;
      font-size: 12px; color: var(--cx-text-faint);
    }
    .hpcx-runline svg { width: 13px; height: 13px; flex: 0 0 auto; opacity: .8; }
    .hpcx-runline code {
      font-family: var(--cx-font-mono); font-size: 11.5px;
      background: var(--cx-chip-bg); color: var(--cx-text-secondary);
      padding: 1px 6px; border-radius: 5px;
    }

    /* ================= 详情 ================= */
    .hpcx-detail-head { margin-bottom: 18px; }
    .hpcx-detail-crumb { font-size: 12px; color: var(--cx-text-faint); margin-bottom: 8px; }
    .hpcx-crumb-link { color: var(--cx-text-dim); text-decoration: none; }
    .hpcx-crumb-link:hover { color: var(--cx-text); text-decoration: underline; }
    .hpcx-detail-meta {
      display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
      font-size: 12.5px; color: var(--cx-text-dim);
    }
    .hpcx-dotsep { color: var(--cx-text-faint); }
    .hpcx-badge {
      display: inline-flex; align-items: center;
      padding: 1px 6px; border-radius: 5px;
      background: var(--cx-chip-bg); color: var(--cx-text-secondary);
      font-size: 10.5px; font-weight: 600;
    }
    .hpcx-badge.op { background: var(--cx-blue-soft); color: var(--cx-blue); }

    .hpcx-turn { margin-bottom: 16px; }
    .hpcx-turn-user { display: flex; justify-content: flex-end; margin-bottom: 6px; }
    .hpcx-turn-user-bubble {
      max-width: 88%;
      background: var(--cx-composer-bg);
      border: 1px solid var(--cx-border);
      border-radius: 14px 14px 4px 14px;
      padding: 12px 15px;
      font-size: 14px; line-height: 1.75;
      word-break: break-word;
    }
    .hpcx-turn-agent {
      padding: 2px 0 2px 17px;
      border-left: 2px solid var(--cx-border);
    }
    .hpcx-cooked { font-size: 14px; line-height: 1.8; color: var(--cx-text); word-break: break-word; }
    .hpcx-cooked img, .hpcx-turn-user-bubble img, .hpcx-quote-body img {
      max-width: min(100%, var(--hpcx-thumb-w));
      max-height: var(--hpcx-thumb-h);
      width: auto; height: auto;
      border-radius: 8px; margin: 6px 0;
      object-fit: contain;
      background: var(--cx-bg-inset);
      cursor: zoom-in;
      display: block;
    }
    /*
     * 这里曾经有一条 ".hpcx-cooked img.hpcx-img-sm { max-width:180px; max-height:180px }"，
     * 给「小图」单写了一个硬编码上限 —— 结果是那些图**完全不看你设的尺寸**。
     * 而且它的判定（markSmallImages 读 naturalWidth）是在图片还没加载时就跑的，
     * 命中与否取决于图片在不在内存缓存里，同一个页面刷新两次结果都不一样。
     *
     * 其实这条规则从一开始就是多余的：max-width / max-height 是**上限**，
     * 天生就不会把小图拉大，不需要额外保护。删掉后所有正文图（含表情）
     * 统一由上面那条规则管，设置才真正说了算。
     */
    .hpcx-img-fallback {
      display: inline-flex; align-items: center; gap: 6px;
      max-width: 320px; margin: 6px 0;
      padding: 7px 11px; border-radius: 8px;
      border: 1px dashed var(--cx-border-strong);
      background: var(--cx-bg-inset);
      color: var(--cx-text-dim); font-size: 12px;
      text-decoration: none;
    }
    .hpcx-img-fallback:hover { color: var(--cx-text); border-color: var(--cx-text-faint); }
    .hpcx-cooked p { margin: 0 0 8px; }
    .hpcx-cooked p:last-child { margin-bottom: 0; }
    .hpcx-cooked a, .hpcx-turn-user-bubble a { color: var(--cx-blue); text-decoration: none; }
    .hpcx-cooked a:hover, .hpcx-turn-user-bubble a:hover { text-decoration: underline; }
    .hpcx-cooked blockquote {
      margin: 8px 0; padding: 2px 0 2px 12px;
      border-left: 2px solid var(--cx-border-strong);
      color: var(--cx-text-secondary);
    }
    .hpcx-cooked code, .hpcx-turn-user-bubble code {
      font-family: var(--cx-font-mono); font-size: 12.5px;
      background: var(--cx-chip-bg); padding: 1px 5px; border-radius: 5px;
    }
    .hpcx-dim { color: var(--cx-text-dim); }

    .hpcx-worked {
      display: flex; align-items: center; flex-wrap: wrap; gap: 7px;
      margin-top: 7px;
      font-size: 12px; color: var(--cx-text-dim);
    }
    .hpcx-floor {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 22px; height: 18px; padding: 0 5px;
      border-radius: 5px;
      background: var(--cx-chip-bg); color: var(--cx-text-secondary);
      font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .hpcx-user { color: var(--cx-text-secondary); text-decoration: none; }
    a.hpcx-user:hover { color: var(--cx-blue); }
    .hpcx-actions { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; opacity: 0; transition: opacity .12s; }
    .hpcx-turn:hover .hpcx-actions { opacity: 1; }
    .hpcx-act {
      display: inline-flex; align-items: center; gap: 4px;
      border: 0; background: transparent; cursor: pointer;
      color: var(--cx-text-faint); font-size: 11.5px;
      padding: 2px 7px; border-radius: 6px; text-decoration: none;
      font-family: var(--cx-font-ui);
    }
    .hpcx-act:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-act:disabled { opacity: .55; cursor: default; }
    .hpcx-act svg { width: 13px; height: 13px; }
    /* 已点亮：心形填充 + 强调色 */
    .hpcx-act-light.on { color: var(--cx-accent); }
    .hpcx-act-light.on svg { fill: currentColor; }

    .hpcx-turn-divider {
      display: flex; align-items: center; gap: 7px;
      margin: 22px 0 16px;
      font-size: 11.5px; color: var(--cx-text-faint);
      letter-spacing: .3px;
    }
    .hpcx-turn-divider::after {
      content: ""; flex: 1 1 auto; height: 1px; background: var(--cx-border-soft);
    }
    .hpcx-turn-divider svg { width: 13px; height: 13px; }

    /* ================= 亮评区 ================= */
    /*
     * 用半透明混色，颜色由设置里的两个 CSS 变量驱动：
     *   --hpcx-lights-bg     用户选的颜色
     *   --hpcx-lights-tint   混色比例（0% = 无底色）
     *   --hpcx-lights-edge   边框浓度
     * 先写一行不带 color-mix 的回退，旧浏览器至少还是个普通卡片。
     */
    .hpcx-lights {
      margin: 4px 0 22px;
      padding: 2px 14px 12px;
      border-radius: 12px;
      border: 1px solid var(--cx-border);
      background: var(--cx-bg-raised);
      background: color-mix(in srgb, var(--hpcx-lights-bg, transparent) var(--hpcx-lights-tint, 0%), transparent);
      border-color: color-mix(in srgb, var(--hpcx-lights-bg, transparent) var(--hpcx-lights-edge, 0%), transparent);
    }
    .hpcx-lights-head {
      display: flex; align-items: center; gap: 7px;
      padding: 10px 2px 8px;
      cursor: pointer; user-select: none;
      font-size: 12px; color: var(--cx-text-secondary);
    }
    .hpcx-lights-head:hover { color: var(--cx-text); }
    .hpcx-lights-ic { display: inline-flex; color: var(--cx-accent); }
    .hpcx-lights-ic svg { width: 14px; height: 14px; }
    .hpcx-lights-title { font-weight: 650; letter-spacing: .2px; }
    .hpcx-lights-count {
      font-size: 11px; font-variant-numeric: tabular-nums;
      padding: 1px 7px; border-radius: 999px;
      background: color-mix(in srgb, var(--hpcx-lights-bg, transparent) var(--hpcx-lights-edge, 0%), transparent);
      border: 1px solid color-mix(in srgb, var(--hpcx-lights-bg, transparent) var(--hpcx-lights-edge, 0%), transparent);
    }
    .hpcx-lights-note { flex: 1 1 auto; font-size: 11.5px; color: var(--cx-text-faint); }
    .hpcx-lights-chev {
      width: 0; height: 0; flex: 0 0 auto;
      border-left: 4px solid currentColor;
      border-top: 3.5px solid transparent;
      border-bottom: 3.5px solid transparent;
      transition: transform .16s ease;
    }
    /* 展开 = ▼，折叠 = ▶ —— 和思考块 / 引用卡片同一个约定 */
    .hpcx-lights:not(.collapsed) .hpcx-lights-chev { transform: rotate(90deg); }
    .hpcx-lights-body { padding-top: 2px; }
    .hpcx-lights.collapsed .hpcx-lights-body { display: none; }
    /* 区块内部的楼层靠得紧一点，读起来是一个整体 */
    .hpcx-lights .hpcx-turn { margin-bottom: 12px; }
    .hpcx-lights .hpcx-turn:last-child { margin-bottom: 0; }
    .hpcx-lights .hpcx-turn-agent { border-left-color: color-mix(in srgb, var(--hpcx-lights-bg, transparent) var(--hpcx-lights-edge, 0%), transparent); }

    .hpcx-quote {
      margin: 0 0 8px;
      border: 1px solid var(--cx-border);
      border-radius: 9px;
      background: var(--cx-bg-inset);
      overflow: hidden;
      max-width: 640px;
    }
    .hpcx-quote-head {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; cursor: pointer;
      font-size: 11.5px; color: var(--cx-text-dim);
      user-select: none;
    }
    .hpcx-quote-head:hover { color: var(--cx-text); }
    .hpcx-quote-ic { display: inline-flex; color: var(--cx-text-faint); }
    .hpcx-quote-ic svg { width: 12px; height: 12px; }
    .hpcx-quote-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hpcx-quote-chev {
      width: 0; height: 0;
      border-left: 4px solid currentColor;
      border-top: 3.5px solid transparent;
      border-bottom: 3.5px solid transparent;
      transition: transform .15s ease;
    }
    .hpcx-quote.open .hpcx-quote-chev { transform: rotate(90deg); }
    .hpcx-quote-body {
      display: none;
      padding: 0 12px 9px;
      font-size: 12.5px; line-height: 1.7; color: var(--cx-text-dim);
    }
    .hpcx-quote.open .hpcx-quote-body { display: block; }
    .hpcx-quote-body p { margin: 0 0 6px; }
    .hpcx-quote-body p:last-child { margin-bottom: 0; }
    .hpcx-quote-img { color: var(--cx-text-faint); font-size: 12px; }

    .hpcx-list-status {
      margin-top: 14px; padding: 12px;
      text-align: center; font-size: 12.5px; color: var(--cx-text-faint);
      border-radius: 9px;
    }
    .hpcx-list-status.pager {
      display: flex; flex-wrap: wrap; gap: 6px; justify-content: center;
      padding: 8px;
    }

    /* ================= 代码面板 ================= */
    .hpcx-code-col {
      border-left: 1px solid var(--cx-border-soft);
      background: var(--cx-panel-bg);
      display: flex; flex-direction: column;
      height: 100vh; overflow: hidden;
      position: relative;
      font-family: var(--cx-font-mono);
    }
    /* 面板在右侧，所以拖拽把手靠在它的左缘 */
    .hpcx-code-col > .hpcx-resizer { left: -3px; right: auto; }
    .hpcx-code-head {
      flex: 0 0 auto;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 10px; height: 46px;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .hpcx-code-tabs { display: flex; align-items: center; gap: 2px; min-width: 0; }
    .hpcx-code-tab {
      display: inline-flex; align-items: center; gap: 7px;
      padding: 5px 9px; border-radius: 7px;
      font-size: 12px; color: var(--cx-text-dim); cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 220px;
    }
    .hpcx-code-tab.on { background: var(--cx-chip-bg); color: var(--cx-text); }
    .hpcx-code-ic {
      font-size: 9.5px; font-weight: 700; letter-spacing: .3px;
      padding: 1px 4px; border-radius: 4px;
      background: var(--cx-blue-soft); color: var(--cx-blue);
    }
    .hpcx-code-tools { position: relative; flex: 0 0 auto; }
    .hpcx-lang-btn {
      display: inline-flex; align-items: center; gap: 5px;
      border: 0; background: transparent; cursor: pointer;
      color: var(--cx-text-dim); font-size: 12px;
      padding: 4px 8px; border-radius: 7px;
      font-family: var(--cx-font-ui);
    }
    .hpcx-lang-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-lang-btn svg { width: 12px; height: 12px; }
    .hpcx-lang-menu {
      position: absolute; right: 0; top: 30px; z-index: 20;
      min-width: 190px; padding: 5px;
      background: var(--cx-bg-raised);
      border: 1px solid var(--cx-border-strong);
      border-radius: 9px;
      box-shadow: 0 10px 30px rgba(0,0,0,.28);
      font-family: var(--cx-font-ui);
    }
    .hpcx-lang-menu > div {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 6px 9px; border-radius: 6px; cursor: pointer;
      font-size: 12.5px; color: var(--cx-text-secondary);
    }
    .hpcx-lang-menu > div:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-lang-menu > div.on { background: var(--cx-blue-soft); color: var(--cx-blue); }
    .hpcx-code-crumb {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 5px;
      padding: 7px 12px;
      font-size: 11px; color: var(--cx-text-faint);
      border-bottom: 1px solid var(--cx-border-soft);
      overflow: hidden; white-space: nowrap;
    }
    .hpcx-code-crumb i { font-style: normal; opacity: .5; }
    .hpcx-code-body {
      flex: 1 1 auto; overflow: auto;
      padding: 10px 0 16px;
      font-size: 11.5px; line-height: 1.72;
      scrollbar-width: thin; scrollbar-color: var(--cx-scroll-thumb) transparent;
    }
    .hpcx-code-body::-webkit-scrollbar { width: 9px; height: 9px; }
    .hpcx-code-body::-webkit-scrollbar-thumb {
      background: var(--cx-scroll-thumb); border-radius: 5px;
      border: 2px solid transparent; background-clip: content-box;
    }
    .hpcx-code-line { display: flex; white-space: pre; padding: 0 12px 0 0; }
    .hpcx-code-line.add { background: var(--cx-diff-add-bg); }
    .hpcx-code-line.del { background: var(--cx-diff-del-bg); }
    .hpcx-code-line.hunk { background: var(--cx-diff-hunk-bg); color: var(--cx-blue); }
    .hpcx-ln {
      flex: 0 0 46px; text-align: right; padding-right: 12px;
      color: var(--cx-code-gutter); user-select: none;
      font-variant-numeric: tabular-nums;
    }
    .hpcx-src { flex: 1 1 auto; color: var(--cx-code-text); }
    .tk-k { color: var(--cx-tok-k); }
    .tk-s { color: var(--cx-tok-s); }
    .tk-c { color: var(--cx-tok-c); font-style: italic; }
    .tk-t { color: var(--cx-tok-t); }
    .tk-n { color: var(--cx-tok-n); }
    .hpcx-code-foot {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 14px;
      padding: 5px 12px;
      font-size: 10.5px; color: var(--cx-text-faint);
      border-top: 1px solid var(--cx-border-soft);
    }

    /* ================= 底部草稿板 ================= */
    .hpcx-composer-wrap {
      flex: 0 0 auto;
      padding: 10px 26px 16px;
      background: linear-gradient(to top, var(--cx-bg) 72%, transparent);
    }
    .hpcx-composer {
      max-width: var(--hpcx-thread-max);
      margin: 0 auto;
      background: var(--cx-composer-bg);
      border: 1px solid var(--cx-border);
      border-radius: 14px;
      padding: 10px 12px 8px;
      box-shadow: 0 4px 18px rgba(0,0,0,.10);
    }
    .hpcx-composer-head {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 7px;
      font-size: 11.5px; color: var(--cx-text-faint);
    }
    .hpcx-composer-target {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      color: var(--cx-text-dim);
    }
    .hpcx-composer-hint { flex: 0 0 auto; }
    .hpcx-editor {
      min-height: 54px; max-height: 240px; overflow-y: auto;
      font-size: 13.5px; line-height: 1.7; color: var(--cx-text);
      white-space: pre-wrap; word-break: break-word;
      outline: none; padding: 2px 0;
      font-family: var(--cx-font-ui);
    }
    .hpcx-editor:empty::before {
      content: attr(data-placeholder);
      color: var(--cx-text-faint);
      pointer-events: none;
    }
    .hpcx-composer-preview {
      border-top: 1px dashed var(--cx-border);
      margin-top: 8px; padding-top: 8px;
      font-size: 13px; line-height: 1.75; color: var(--cx-text-secondary);
      max-height: 260px; overflow-y: auto;
    }
    .hpcx-composer-preview p { margin: 0 0 7px; }
    .hpcx-composer-preview ul { margin: 0 0 7px; padding-left: 20px; }
    .hpcx-composer-preview blockquote {
      margin: 0 0 7px; padding: 2px 0 2px 10px;
      border-left: 2px solid var(--cx-border-strong);
    }
    .hpcx-composer-preview code {
      font-family: var(--cx-font-mono); font-size: 12px;
      background: var(--cx-chip-bg); padding: 1px 5px; border-radius: 5px;
    }
    .hpcx-composer-bar {
      display: flex; align-items: center; gap: 6px;
      margin-top: 8px; padding-top: 7px;
      border-top: 1px solid var(--cx-border-soft);
      flex-wrap: wrap;
    }
    .hpcx-ct-group { display: flex; align-items: center; gap: 1px; }
    .hpcx-ct-btn {
      width: 27px; height: 27px; border: 0; border-radius: 7px;
      background: transparent; color: var(--cx-text-dim); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .hpcx-ct-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-ct-btn svg { width: 14px; height: 14px; }
    .hpcx-composer-status {
      flex: 1 1 auto; min-width: 60px;
      font-size: 11px; color: var(--cx-text-faint);
      text-align: right;
    }
    .hpcx-send {
      display: inline-flex; align-items: center; gap: 6px;
      border: 0; border-radius: 8px; cursor: pointer;
      background: var(--cx-send-bg); color: var(--cx-send-icon);
      padding: 6px 12px; font-size: 12.5px; font-weight: 600;
      font-family: var(--cx-font-ui); text-decoration: none;
    }
    .hpcx-send:hover { filter: brightness(1.08); }
    .hpcx-send:disabled { opacity: .6; cursor: default; filter: none; }
    .hpcx-send svg { width: 14px; height: 14px; }
    .hpcx-send.ghost {
      background: transparent; color: var(--cx-text-dim);
      border: 1px solid var(--cx-border);
    }
    .hpcx-send.ghost:hover { background: var(--cx-btn-hover); color: var(--cx-text); }

    /* 顶部那一行：正在回复某楼时换成「回复 @xxx · 第 N 楼 ✕」 */
    .hpcx-composer-target.quoting {
      display: inline-flex; align-items: center; gap: 6px;
      color: var(--cx-accent);
    }
    .hpcx-composer-target.quoting svg { width: 13px; height: 13px; flex: 0 0 auto; }
    .hpcx-composer-target.quoting > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hpcx-quote-cancel {
      flex: 0 0 auto;
      border: 0; background: transparent; cursor: pointer;
      color: var(--cx-text-dim); font-size: 15px; line-height: 1;
      padding: 0 4px; border-radius: 5px;
      font-family: var(--cx-font-ui);
    }
    .hpcx-quote-cancel:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    /* 状态文字：发送结果 */
    .hpcx-composer-status[data-kind="ok"] { color: var(--cx-blue); }
    .hpcx-composer-status[data-kind="err"] { color: #e5534b; }

    /* ================= 灯箱 / 悬浮预览 ================= */
    .hpcx-lightbox {
      position: fixed; inset: 0; z-index: 2147483600;
      background: rgba(0,0,0,.86);
      display: flex; align-items: center; justify-content: center;
      cursor: zoom-out;
    }
    .hpcx-lightbox img {
      max-width: 94vw; max-height: 92vh;
      border-radius: 10px; box-shadow: 0 20px 60px rgba(0,0,0,.5);
    }
    .hpcx-lightbox-x {
      position: absolute; top: 18px; right: 24px;
      font-size: 30px; line-height: 1; color: #fff; opacity: .7; cursor: pointer;
    }
    .hpcx-lightbox-x:hover { opacity: 1; }
    .hpcx-imgprev {
      position: fixed;
      /* 位置由 placeImgPreview() 算好后写进 inline style（left/top）。
         这里千万不要写 right/bottom —— 它们是坐标系的另一边，
         同时存在会让 fixed 元素被拉开，或者把位置完全盖掉 ——
         之前写死了 right:18px;bottom:18px，所以预览永远贴在右下角。 */
      left: 0; top: 0;
      z-index: 2147483400;
      pointer-events: none; opacity: 0; visibility: hidden;
      /* visibility 也放进 transition：淡出时才能把整段动画看完
         （discrete 属性会在过渡结束时才翻成 hidden） */
      transition: opacity .12s ease, visibility .12s;
      border-radius: 10px; overflow: hidden;
      border: 1px solid var(--cx-border-strong);
      box-shadow: 0 14px 40px rgba(0,0,0,.4);
      background: var(--cx-bg-raised);
      max-width: 42vw; max-height: 52vh;
    }
    .hpcx-imgprev.on { opacity: 1; visibility: visible; }
    .hpcx-imgprev img { display: block; max-width: 42vw; max-height: 52vh; }

    /* ================= toast ================= */
    .hpcx-toast {
      position: fixed; left: 50%; bottom: 34px; transform: translate(-50%, 12px);
      z-index: 2147483600;
      background: var(--cx-bg-raised); color: var(--cx-text);
      border: 1px solid var(--cx-border-strong);
      padding: 8px 16px; border-radius: 999px;
      font-size: 12.5px; font-family: var(--cx-font-ui);
      opacity: 0; pointer-events: none;
      transition: opacity .16s ease, transform .16s ease;
      box-shadow: 0 10px 30px rgba(0,0,0,.28);
    }
    .hpcx-toast.on { opacity: 1; transform: translate(-50%, 0); }

    /* ================= 应急伪装视图 ================= */
    .hpcx-boss {
      position: fixed; inset: 0; z-index: 2147483500;
      background: var(--cx-bg);
      display: grid;
      grid-template-rows: 40px minmax(0, 1fr) minmax(180px, 32vh);
      font-family: var(--cx-font-mono);
      color: var(--cx-code-text);
    }
    .hpcx-boss[hidden] { display: none; }
    html.${BOSS_CLASS} .hpcx-rail,
    html.${BOSS_CLASS} .hpcx-main { display: none !important; }
    html.${BOSS_CLASS} body { overflow: hidden; }
    .hpcx-boss-bar {
      display: flex; align-items: center; gap: 10px;
      padding: 0 14px;
      border-bottom: 1px solid var(--cx-border-soft);
      font-size: 12px;
    }
    .hpcx-boss-tab {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 7px;
      color: var(--cx-text-dim);
    }
    .hpcx-boss-tab.on { background: var(--cx-chip-bg); color: var(--cx-text); }
    .hpcx-boss-tab .ic {
      font-size: 9.5px; font-weight: 700; padding: 1px 4px; border-radius: 4px;
      background: var(--cx-blue-soft); color: var(--cx-blue);
    }
    .hpcx-boss-spacer { flex: 1 1 auto; }
    .hpcx-boss-shell { color: var(--cx-text-faint); font-size: 11.5px; }
    .hpcx-boss-editor {
      overflow: hidden; padding: 8px 0;
      font-size: 12.5px; line-height: 1.75;
    }
    .hpcx-boss-term {
      border-top: 1px solid var(--cx-border-soft);
      display: flex; flex-direction: column; min-height: 0;
    }
    .hpcx-boss-term-head {
      display: flex; align-items: center; gap: 14px;
      padding: 5px 14px; font-size: 11px; color: var(--cx-text-faint);
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .hpcx-boss-term-body {
      flex: 1 1 auto; overflow: auto; margin: 0;
      padding: 10px 14px;
      font-size: 12px; line-height: 1.7;
      white-space: pre-wrap;
      font-family: var(--cx-font-mono);
    }
    .hpcx-boss-term-body .cmd { color: var(--cx-text); }
    .hpcx-boss-term-body .dim { color: var(--cx-text-faint); }
    .hpcx-boss-term-body .ok { color: #6cc46c; }
    .hpcx-boss-caret {
      display: inline-block; width: 7px; height: 14px;
      background: var(--cx-text); vertical-align: -2px;
      animation: hpcx-blink 1.05s step-end infinite;
    }
    @keyframes hpcx-blink { 50% { opacity: 0; } }

    /* ================= 发新帖弹框 ================= */
    .hpcx-publish {
      position: fixed; inset: 0; z-index: 2147483560;
      background: rgba(0,0,0,.42);
      display: flex; align-items: center; justify-content: center;
      font-family: var(--cx-font-ui);
    }
    .hpcx-publish[hidden] { display: none; }
    .hpcx-publish-card {
      width: min(720px, 94vw); max-height: 88vh;
      display: flex; flex-direction: column;
      background: var(--cx-bg-raised); color: var(--cx-text);
      border: 1px solid var(--cx-border-strong);
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 24px 70px rgba(0,0,0,.45);
    }
    .hpcx-publish-head {
      display: flex; align-items: center; gap: 9px;
      padding: 13px 18px 11px;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .hpcx-publish-title { font-size: 15px; font-weight: 650; }
    .hpcx-publish-board {
      font-size: 11.5px; padding: 2px 8px; border-radius: 999px;
      background: var(--cx-chip-bg); color: var(--cx-text-secondary);
    }
    .hpcx-publish-head .hpcx-modal-x { margin-left: auto; }
    .hpcx-publish-body { flex: 1 1 auto; overflow-y: auto; padding: 14px 18px; }
    .hpcx-publish-input, .hpcx-publish-text {
      width: 100%; box-sizing: border-box;
      background: var(--cx-bg-inset); color: var(--cx-text);
      border: 1px solid var(--cx-border); border-radius: 9px;
      padding: 9px 11px; font-size: 13.5px;
      font-family: var(--cx-font-ui);
    }
    .hpcx-publish-input { margin-bottom: 10px; font-size: 14.5px; font-weight: 600; }
    .hpcx-publish-text { resize: vertical; min-height: 150px; line-height: 1.75; }
    .hpcx-publish-input:focus, .hpcx-publish-text:focus {
      outline: none; border-color: var(--cx-blue);
    }
    .hpcx-publish-status { min-height: 18px; margin-top: 8px; font-size: 12px; color: var(--cx-text-faint); }
    .hpcx-publish-status[data-kind="ok"] { color: var(--cx-blue); }
    .hpcx-publish-status[data-kind="err"] { color: #e5534b; }
    .hpcx-publish-foot {
      display: flex; align-items: center; gap: 10px;
      padding: 11px 18px;
      border-top: 1px solid var(--cx-border-soft);
      font-size: 11.5px;
    }
    .hpcx-publish-foot .hpcx-dim { flex: 1 1 auto; }

    /* ================= 设置面板 ================= */
    .hpcx-modal {
      position: fixed; inset: 0; z-index: 2147483550;
      background: rgba(0,0,0,.42);
      display: flex; align-items: center; justify-content: center;
      font-family: var(--cx-font-ui);
    }
    .hpcx-modal[hidden] { display: none; }
    .hpcx-modal-card {
      width: min(680px, 92vw); max-height: 82vh;
      display: flex; flex-direction: column;
      background: var(--cx-bg-raised); color: var(--cx-text);
      border: 1px solid var(--cx-border-strong);
      border-radius: 14px; overflow: hidden;
      box-shadow: 0 24px 70px rgba(0,0,0,.42);
    }
    .hpcx-modal-head {
      display: flex; align-items: baseline; gap: 10px;
      padding: 14px 18px 12px;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .hpcx-modal-title { font-size: 15px; font-weight: 650; }
    .hpcx-modal-sub { flex: 1 1 auto; font-size: 11.5px; color: var(--cx-text-faint); }
    .hpcx-modal-x {
      border: 0; background: transparent; cursor: pointer;
      color: var(--cx-text-dim); font-size: 22px; line-height: 1;
      padding: 0 4px;
    }
    .hpcx-modal-x:hover { color: var(--cx-text); }
    .hpcx-modal-body { flex: 1 1 auto; overflow-y: auto; padding: 6px 18px 14px; }
    .hpcx-set-section {
      padding: 14px 0 6px;
      font-size: 11px; font-weight: 700; letter-spacing: .6px;
      text-transform: uppercase; color: var(--cx-text-faint);
    }
    .hpcx-set-row {
      display: flex; align-items: center; gap: 16px;
      padding: 8px 0;
      border-bottom: 1px solid var(--cx-border-soft);
    }
    .hpcx-set-label { flex: 1 1 auto; min-width: 0; font-size: 13px; }
    .hpcx-set-hint { margin-top: 2px; font-size: 11.5px; color: var(--cx-text-faint); line-height: 1.5; }
    .hpcx-set-ctrl { flex: 0 0 auto; display: flex; align-items: center; gap: 9px; }
    .hpcx-set-val {
      min-width: 48px; text-align: right;
      font-size: 11.5px; color: var(--cx-text-dim);
      font-variant-numeric: tabular-nums;
    }
    .hpcx-switch {
      width: 38px; height: 22px; border-radius: 999px; border: 0;
      background: var(--cx-chip-bg); cursor: pointer; position: relative;
      transition: background .15s ease;
    }
    .hpcx-switch > span {
      position: absolute; top: 3px; left: 3px;
      width: 16px; height: 16px; border-radius: 50%;
      background: var(--cx-text-dim);
      transition: transform .15s ease, background .15s ease;
    }
    .hpcx-switch.on { background: var(--cx-blue); }
    .hpcx-switch.on > span { transform: translateX(16px); background: #fff; }
    .hpcx-range { width: 150px; accent-color: var(--cx-blue); }
    .hpcx-select, .hpcx-text {
      background: var(--cx-bg-inset); color: var(--cx-text);
      border: 1px solid var(--cx-border); border-radius: 8px;
      padding: 5px 9px; font-size: 12.5px; min-width: 150px;
      font-family: var(--cx-font-ui);
    }
    /* 颜色控件：色块 + 「无」开关 */
    .hpcx-color { display: flex; align-items: center; gap: 6px; }
    .hpcx-color-input {
      width: 42px; height: 26px; padding: 2px;
      background: var(--cx-bg-inset);
      border: 1px solid var(--cx-border); border-radius: 8px;
      cursor: pointer;
    }
    .hpcx-color-input::-webkit-color-swatch-wrapper { padding: 0; }
    .hpcx-color-input::-webkit-color-swatch { border: 0; border-radius: 5px; }
    .hpcx-color.off .hpcx-color-input { opacity: .35; }
    .hpcx-color-off {
      border: 1px solid var(--cx-border); background: transparent;
      color: var(--cx-text-dim); border-radius: 8px;
      padding: 4px 9px; font-size: 12px; cursor: pointer;
      font-family: var(--cx-font-ui);
    }
    .hpcx-color-off:hover { background: var(--cx-btn-hover); color: var(--cx-text); }
    .hpcx-color-off.on { background: var(--cx-blue-soft); color: var(--cx-blue); border-color: transparent; }
    .hpcx-modal-foot {
      display: flex; align-items: center; gap: 12px;
      padding: 11px 18px;
      border-top: 1px solid var(--cx-border-soft);
      font-size: 11.5px; color: var(--cx-text-faint);
    }
    .hpcx-modal-foot code {
      font-family: var(--cx-font-mono); background: var(--cx-chip-bg);
      padding: 1px 5px; border-radius: 4px;
    }
    .hpcx-modal-btn {
      border: 1px solid var(--cx-border); background: transparent;
      color: var(--cx-text-secondary); border-radius: 8px;
      padding: 5px 11px; font-size: 12.5px; cursor: pointer;
      font-family: var(--cx-font-ui); flex: 0 0 auto;
    }
    .hpcx-modal-btn:hover { background: var(--cx-btn-hover); color: var(--cx-text); }

    /* ================= 窄屏降级 ================= */
    @media (max-width: 1180px) {
      .hpcx-main { grid-template-columns: minmax(0, 1fr); }
      .hpcx-code-col { display: none; }
    }
    @media (max-width: 860px) {
      .hpcx-rail { transform: translateX(-100%); }
      html.hpcx-rail-open .hpcx-rail { transform: translateX(0); }
      html.hpcx-rail-open::after {
        content: ""; position: fixed; inset: 0; z-index: 2147482999;
        background: rgba(0,0,0,.4);
      }
      .hpcx-main { margin-left: 0; }
      .hpcx-menu-btn { display: inline-flex; }
      .hpcx-thread-inner { padding: 16px 14px 30px; }
      .hpcx-composer-wrap { padding: 8px 14px 12px; }
      .hpcx-actions { opacity: 1; }
    }
  `;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = RAW_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function applyFavicon() {
    if (!document.head) return;
    let link = document.getElementById(FAVICON_ID);
    const uri = makeFaviconUri();
    // 切回原图标：把自己的 link 摘掉，把站点原本的 rel=icon 放出来
    if (!uri) {
      if (link) link.remove();
      document.querySelectorAll('link[rel*="icon"]').forEach((l) => { l.disabled = false; });
      return;
    }
    if (!link) {
      link = document.createElement("link");
      link.id = FAVICON_ID;
      link.rel = "icon";
      link.type = "image/svg+xml";
      document.head.appendChild(link);
    }
    link.href = uri;
    document.querySelectorAll('link[rel*="icon"]').forEach((l) => {
      if (l !== link) l.disabled = true;
    });
  }

  /* ============================== 隐蔽性 ==============================
   *
   * 上班摸鱼真正需要的不是「好看」，而是一眼扫过去不像论坛：
   *   1. 标签页标题伪装成源码文件名
   *   2. 应急伪装键：整个视口瞬间变成「代码编辑器 + 正在跑测试的终端」
   * 伪装视图沿用同一套 token 和同一份假代码生成器，所以切换时看起来像
   * 在同一个 IDE 里换了个面板，而不是「网页变了」。
   * ================================================================= */

  function syncTitle() {
    if (!cfg("stealth")) {
      if (NATIVE_TITLE && document.title !== NATIVE_TITLE) document.title = NATIVE_TITLE;
      return;
    }
    const L = CODE_LANGS[getLang()];
    const want = L.file + " \u2014 " + (L.root || cfg("projectName"));
    if (document.title !== want) document.title = want;
  }

  function bossOn() {
    return document.documentElement.classList.contains(BOSS_CLASS);
  }

  /** 终端里那串「看起来刚跑完」的构建日志（按种子稳定） */
  const BOSS_TESTS = [
    "cache::tests::stale_entry_is_dropped",
    "cache::tests::refresh_updates_ttl",
    "http::tests::etag_is_stable_across_calls",
    "store::tests::upsert_is_idempotent",
    "parse::tests::unescapes_html_entities",
    "config::tests::env_overrides_file"
  ];

  function bossLogHtml(seed) {
    const rnd = mulberry32(seed);
    const L = CODE_LANGS[getLang()] || CODE_LANGS.rust;
    const out = [];
    out.push('<span class="cmd">$ cargo build --release</span>');
    out.push('<span class="dim">   Compiling ' + escapeHtml(L.root || "platform") + '-engine v0.9.3 (/Users/dev/work/' + escapeHtml(L.root || "platform") + '-engine)</span>');
    out.push('<span class="dim">   Compiling topic-cache v0.2.4</span>');
    out.push('<span class="ok">    Finished</span> release [optimized] target(s) in ' + (6 + rnd() * 9).toFixed(1) + "s");
    out.push("");
    out.push('<span class="cmd">$ cargo test --release --quiet</span>');
    out.push('<span class="dim">running ' + BOSS_TESTS.length + " tests</span>");
    for (const t of BOSS_TESTS) out.push("test " + t + ' ... <span class="ok">ok</span>');
    out.push("");
    out.push('test result: <span class="ok">ok</span>. ' + BOSS_TESTS.length +
      " passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in " +
      (0.2 + rnd() * 0.6).toFixed(2) + "s");
    out.push("");
    out.push('<span class="cmd">$ git diff --stat</span>');
    out.push(" 3 files changed, " + (20 + Math.floor(rnd() * 90)) + " insertions(+), " +
      Math.floor(rnd() * 20) + " deletions(-)");
    out.push("");
    out.push('<span class="cmd">$ <span class="hpcx-boss-caret"></span></span>');
    return out.join("\n");
  }

  function ensureBoss() {
    let box = document.querySelector(".hpcx-boss");
    if (box) return box;
    box = el("div", "hpcx-boss");
    box.hidden = true;
    box.innerHTML =
      '<div class="hpcx-boss-bar">' +
      '<span data-boss-tabs style="display:flex;align-items:center;gap:2px"></span>' +
      '<span class="hpcx-boss-spacer"></span>' +
      '<span class="hpcx-boss-shell" data-boss-shell></span>' +
      "</div>" +
      '<div class="hpcx-boss-editor" data-boss-code></div>' +
      '<div class="hpcx-boss-term">' +
      '<div class="hpcx-boss-term-head"><span>Terminal</span><span>zsh</span><span>cargo</span></div>' +
      '<pre class="hpcx-boss-term-body" data-boss-log></pre>' +
      "</div>";
    box.setAttribute("data-hpcx", "");
    document.body.appendChild(box);
    return box;
  }

  function renderBoss() {
    const box = document.querySelector(".hpcx-boss");
    if (!box) return;
    const cur = getLang();
    const others = Object.keys(CODE_LANGS).filter((k) => k !== cur).slice(0, 2);
    const tabs = [cur].concat(others);

    const tabsEl = box.querySelector("[data-boss-tabs]");
    if (tabsEl) {
      tabsEl.innerHTML = tabs.map((k, i) => {
        const l = CODE_LANGS[k];
        return '<span class="hpcx-boss-tab' + (i === 0 ? " on" : "") + '">' +
          '<span class="ic">' + escapeHtml(l.icon) + "</span>" + escapeHtml(l.file) + "</span>";
      }).join("");
    }

    const L = CODE_LANGS[cur];
    const seed = panelSeed();
    const codeEl = box.querySelector("[data-boss-code]");
    if (codeEl) {
      const lines = genCodeLines(cur);
      codeEl.innerHTML = lines.map((line, i) =>
        '<div class="hpcx-code-line"><span class="hpcx-ln">' + (i + 1) + "</span>" +
        '<span class="hpcx-src">' + highlightCode(line, L) + "</span></div>").join("");
      codeEl.scrollTop = 0;
    }
    const logEl = box.querySelector("[data-boss-log]");
    if (logEl) {
      logEl.innerHTML = bossLogHtml(seed);
      const toBottom = () => { logEl.scrollTop = logEl.scrollHeight; };
      toBottom();
      requestAnimationFrame(toBottom);
    }
    const shellEl = box.querySelector("[data-boss-shell]");
    if (shellEl) shellEl.textContent = "~/work/" + (L.root || "platform") + "-engine";
  }

  /** 切换应急伪装视图。只切外观，不卸载任何真实 DOM，恢复时无损失 */
  function setBoss(on) {
    if (!cfg("stealth")) return;
    const box = ensureBoss();
    if (on) {
      // 切进去之前把输入焦点交出去，避免草稿框还在吃按键
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      renderBoss();
      box.hidden = false;
    } else {
      box.hidden = true;
    }
    document.documentElement.classList.toggle(BOSS_CLASS, !!on);
  }

  /** "ctrl+shift+h" / "f2" 这类组合键匹配 */
  function bossKeyMatch(e, spec) {
    const parts = String(spec || "").toLowerCase().split("+").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) return false;
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    const wantCtrl = mods.indexOf("ctrl") >= 0 || mods.indexOf("cmd") >= 0 || mods.indexOf("meta") >= 0;
    if (wantCtrl !== (e.ctrlKey || e.metaKey)) return false;
    if ((mods.indexOf("alt") >= 0) !== e.altKey) return false;
    if ((mods.indexOf("shift") >= 0) !== e.shiftKey) return false;
    return (e.key || "").toLowerCase() === key;
  }

  let lastEscAt = 0;

  function bindSettingsKeys() {
    window.addEventListener("keydown", (e) => {
      // Ctrl/⌘ + , —— 和 VS Code / macOS 的「偏好设置」一致
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        toggleSettings();
      }
    }, true);
  }

  function bindStealthKeys() {
    const spec = String(cfg("stealthKey") || "esc2").toLowerCase();
    window.addEventListener("keydown", (e) => {
      // Esc 的优先级：发新帖弹框 > 设置面板 > 灯箱 > 应急伪装
      if (e.key === "Escape" && publishOpen()) {
        e.preventDefault();
        closePublish();
        return;
      }
      // 设置面板开着时 Esc 先关面板（别再触发应急伪装）
      if (e.key === "Escape" && settingsOpen()) {
        e.preventDefault();
        closeSettings();
        return;
      }
      if (spec === "esc2" && e.key === "Escape") {
        // 灯箱开着时 Esc 属于灯箱
        if (lightboxOpen) return;
        // 应急键的价值就在于「任何时候一按就藏」，所以即使在草稿框里打字也照样生效
        const now = Date.now();
        if (now - lastEscAt < 450) {
          lastEscAt = 0;
          e.preventDefault();
          setBoss(!bossOn());
        } else {
          lastEscAt = now;
        }
        return;
      }
      if (bossKeyMatch(e, spec) || bossKeyMatch(e, "ctrl+shift+h")) {
        e.preventDefault();
        e.stopPropagation();
        setBoss(!bossOn());
      }
    }, true);
  }

  /* ============================== 设置面板 ============================== */

  const SETTING_CSS_VAR = {
    railWidth: "--cx-rail-w",
    panelWidth: "--hpcx-panel-w",
    threadMaxWidth: "--hpcx-thread-max",
    thumbWidth: "--hpcx-thumb-w",
    thumbHeight: "--hpcx-thumb-h"
  };

  /** 颜色类设置的默认色（用户点了「重置颜色」就回到这里） */
  const COLOR_FALLBACK = "#f0d1c6";

  const SETTING_SPEC = [
    { section: "外观", items: [
      { key: "theme", type: "select", label: "主题", hint: "「跟随系统」读操作系统的深色偏好",
        options: [["auto", "跟随系统"], ["dark", "深色"], ["light", "浅色"]] },
      { key: "railWidth", type: "range", label: "左栏宽度", min: 200, max: 520, step: 2, unit: "px" },
      { key: "panelWidth", type: "range", label: "代码面板宽度", min: 240, max: 900, step: 4, unit: "px" },
      { key: "threadMaxWidth", type: "range", label: "正文最大宽度", min: 560, max: 1100, step: 10, unit: "px" },
      { key: "codePanel", type: "toggle", label: "显示右侧代码面板", hint: "那块代码是假数据，纯氛围" },
      { key: "lang", type: "select", label: "代码面板语言",
        options: () => Object.keys(CODE_LANGS).map((k) => [k, CODE_LANGS[k].label]) },
      { key: "codeMode", type: "select", label: "代码面板视图", options: [["code", "代码"], ["diff", "diff"]] }
    ] },
    { section: "伪装", items: [
      { key: "stealth", type: "toggle", label: "伪装模式",
        hint: "品牌名 → Codex、标签页标题 → 源码文件名、启用下面的应急键" },
      { key: "brandName", type: "text", label: "左栏品牌名", placeholder: "留空 = 跟随伪装模式" },
      { key: "projectName", type: "text", label: "项目名",
        hint: "出现在代码面板面包屑和标签页标题里（如 \"topic_cache.rs — platform\"）" },
      { key: "stealthKey", type: "select", label: "应急伪装键", hint: "Ctrl+Shift+H 始终有效",
        options: [["esc2", "连按两下 Esc"], ["f2", "F2"], ["ctrl+shift+h", "Ctrl+Shift+H"]] },
      { key: "favicon", type: "select", label: "标签页图标",
        options: [["codex", "Codex 风格圆角图标"], ["site", "保留虎扑原图标"]] }
    ] },
    { section: "Agent 装饰", items: [
      { key: "decorations", type: "toggle", label: "启用 agent 装饰",
        hint: "思考块和工具调用行。内容是按种子生成的假文案，跟帖子无关，纯装饰" },
      { key: "listTraceRate", type: "range", label: "列表痕迹密度", min: 0, max: 100, step: 2, unit: "%",
        hint: "0 = 列表里不插痕迹" },
      { key: "listThinkingOpen", type: "toggle", label: "列表思考块默认展开",
        hint: "关掉时只占一行「✻ Worked for Ns ▸」，点一下展开" },
      { key: "detailThinkingOpen", type: "toggle", label: "详情页思考块默认展开" }
    ] },
    { section: "亮评", items: [
      { key: "showLights", type: "toggle", label: "单独分出「亮评」区",
        hint: "虎扑把被点亮最多的回复单列一栏；关掉就混回普通回复里，不单独显示" },
      { key: "lightsCollapsed", type: "toggle", label: "亮评区默认折叠",
        hint: "折叠后只留一行标题，点标题随时展开（临时展开不影响这个默认值）" },
      { key: "lightsBg", type: "color", label: "亮评区底色",
        hint: "按半透明混色刷上去，所以任意颜色在明暗两种主题下都能看清字；点「无」则不加底色" },
      { key: "lightsTint", type: "range", label: "底色浓度", min: 0, max: 60, step: 2, unit: "%",
        hint: "0% 等于没有底色（保留边框）" }
    ] },
    { section: "楼层", items: [
      { key: "quoteCard", type: "toggle", label: "把楼层引用渲染成卡片",
        hint: "虎扑的引用是结构化的（quote 字段），开启后渲染成可折叠卡片" },
      { key: "quoteOpen", type: "toggle", label: "引用卡片默认展开" }
    ] },
    { section: "正文图片", items: [
      { key: "thumbWidth", type: "range", label: "图片宽度上限", min: 120, max: 700, step: 10, unit: "px",
        hint: "只「封顶」不放大：比这个尺寸小的图（虎扑自带的表情大多 46~132px）保持原样" },
      { key: "thumbHeight", type: "range", label: "图片高度上限", min: 80, max: 500, step: 10, unit: "px",
        hint: "同上。竖图主要受这一项约束，想压缩表情就调它" },
      { key: "thumbPreview", type: "toggle", label: "鼠标悬停浮出大图" }
    ] }
  ];

  function specItem(key) {
    for (const g of SETTING_SPEC) {
      for (const it of g.items) if (it.key === key) return it;
    }
    return null;
  }

  function settingControlHtml(it) {
    const v = cfg(it.key);
    if (it.type === "toggle") {
      return '<button type="button" class="hpcx-switch' + (v ? " on" : "") + '"' +
        ' role="switch" aria-checked="' + (v ? "true" : "false") + '"' +
        ' data-set-toggle="' + it.key + '" aria-label="' + escapeHtml(it.label) + '"><span></span></button>';
    }
    if (it.type === "range") {
      return '<input type="range" class="hpcx-range" data-set-range="' + it.key + '"' +
        ' min="' + it.min + '" max="' + it.max + '" step="' + it.step + '" value="' + v + '">' +
        '<span class="hpcx-set-val" data-set-val="' + it.key + '">' + v + (it.unit || "") + "</span>";
    }
    if (it.type === "select") {
      const opts = typeof it.options === "function" ? it.options() : it.options;
      return '<select class="hpcx-select" data-set-select="' + it.key + '">' +
        opts.map(([val, text]) =>
          '<option value="' + escapeHtml(val) + '"' +
          (String(v) === String(val) ? " selected" : "") + ">" + escapeHtml(text) + "</option>").join("") +
        "</select>";
    }
    if (it.type === "color") {
      // 色块 + 原生取色器；旁边一个「无」按钮用来清空（空字符串 = 不用底色）
      const cur = /^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : (it.fallback || COLOR_FALLBACK);
      const off = String(v || "") === "";
      return '<span class="hpcx-color' + (off ? " off" : "") + '" data-color-wrap="' + it.key + '">' +
        '<input type="color" class="hpcx-color-input" data-set-color="' + it.key + '" value="' +
        escapeHtml(cur) + '" aria-label="' + escapeHtml(it.label) + '">' +
        '<button type="button" class="hpcx-color-off' + (off ? " on" : "") + '"' +
        ' data-color-off="' + it.key + '" title="不用底色">无</button>' +
        "</span>";
    }
    return '<input type="text" class="hpcx-text" data-set-text="' + it.key + '" value="' +
      escapeHtml(v) + '" placeholder="' + escapeHtml(it.placeholder || "") + '">';
  }

  function settingsOpen() {
    const m = document.querySelector(".hpcx-modal");
    return !!m && !m.hidden;
  }

  function closeSettings() {
    const m = document.querySelector(".hpcx-modal");
    if (m) m.hidden = true;
  }

  function previewSetting(key, value) {
    const varName = SETTING_CSS_VAR[key];
    if (varName) document.documentElement.style.setProperty(varName, value + "px");
  }

  function syncSettingControls() {
    const m = document.querySelector(".hpcx-modal");
    if (!m || m.hidden) return;
    m.querySelectorAll("[data-set-toggle]").forEach((n) => {
      const on = !!cfg(n.dataset.setToggle);
      n.classList.toggle("on", on);
      n.setAttribute("aria-checked", on ? "true" : "false");
    });
    m.querySelectorAll("[data-set-range]").forEach((n) => {
      const it = specItem(n.dataset.setRange);
      n.value = cfg(n.dataset.setRange);
      const out = m.querySelector('[data-set-val="' + n.dataset.setRange + '"]');
      if (out) out.textContent = n.value + ((it && it.unit) || "");
    });
    m.querySelectorAll("[data-set-select]").forEach((n) => { n.value = cfg(n.dataset.setSelect); });
    m.querySelectorAll("[data-set-text]").forEach((n) => { n.value = cfg(n.dataset.setText); });
    m.querySelectorAll("[data-set-color]").forEach((n) => {
      const key = n.dataset.setColor;
      const it = specItem(key);
      n.value = /^#[0-9a-f]{6}$/i.test(String(cfg(key))) ? cfg(key) : (it && it.fallback) || COLOR_FALLBACK;
      const wrap = n.closest("[data-color-wrap]");
      const off = String(cfg(key) || "") === "";
      if (wrap) wrap.classList.toggle("off", off);
      const btn = wrap && wrap.querySelector("[data-color-off]");
      if (btn) btn.classList.toggle("on", off);
    });
  }

  function renderSettingsPanel() {
    let m = document.querySelector(".hpcx-modal");
    if (!m) {
      m = el("div", "hpcx-modal");
      m.hidden = true;
      m.setAttribute("data-hpcx", "");
      document.body.appendChild(m);
    }
    const rows = SETTING_SPEC.map((g) =>
      '<div class="hpcx-set-section">' + escapeHtml(g.section) + "</div>" +
      g.items.map((it) =>
        '<div class="hpcx-set-row" data-row="' + it.key + '">' +
        '<div class="hpcx-set-label"><span>' + escapeHtml(it.label) + "</span>" +
        (it.hint ? '<div class="hpcx-set-hint">' + escapeHtml(it.hint) + "</div>" : "") +
        "</div>" +
        '<div class="hpcx-set-ctrl">' + settingControlHtml(it) + "</div>" +
        "</div>").join("")
    ).join("");

    m.innerHTML =
      '<div class="hpcx-modal-card" role="dialog" aria-modal="true" aria-label="设置">' +
      '<div class="hpcx-modal-head">' +
      '<span class="hpcx-modal-title">设置</span>' +
      '<span class="hpcx-modal-sub">改动即时生效并存在本机</span>' +
      '<button type="button" class="hpcx-modal-x" data-settings-close title="关闭（Esc）">×</button>' +
      "</div>" +
      '<div class="hpcx-modal-body">' + rows + "</div>" +
      '<div class="hpcx-modal-foot">' +
      '<button type="button" class="hpcx-modal-btn" data-settings-reset>恢复默认</button>' +
      '<span>设置存在 localStorage 的 <code>hpcx:settings</code>，清掉就回到初始状态</span>' +
      "</div>" +
      "</div>";
    return m;
  }

  function openSettings() {
    const m = renderSettingsPanel();
    m.hidden = false;
    m.querySelector("[data-settings-close]")?.focus();
  }

  function toggleSettings() {
    if (settingsOpen()) closeSettings();
    else openSettings();
  }

  function bindSettingsPanel() {
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest && t.closest("[data-settings-open]")) { openSettings(); return; }
      if (!settingsOpen()) return;

      const m = document.querySelector(".hpcx-modal");
      if (t.closest("[data-settings-close]")) { closeSettings(); return; }
      if (t.closest("[data-settings-reset]")) {
        resetSettings();
        renderSettingsPanel();
        toastNow("已恢复默认设置");
        return;
      }
      if (t === m) { closeSettings(); return; }

      const sw = t.closest("[data-set-toggle]");
      if (sw) {
        const key = sw.dataset.setToggle;
        const next = !cfg(key);
        sw.classList.toggle("on", next);
        sw.setAttribute("aria-checked", next ? "true" : "false");
        setCfg(key, next);
        return;
      }

      // 「无」按钮：把颜色类设置清成空字符串
      const offBtn = t.closest("[data-color-off]");
      if (offBtn) {
        const key = offBtn.dataset.colorOff;
        const wrap = offBtn.closest("[data-color-wrap]");
        if (wrap) wrap.classList.add("off");
        offBtn.classList.add("on");
        setCfg(key, "");
        return;
      }
    });

    // 滑块 / 取色器：input 只预览，change 才落盘 + 重渲染
    document.addEventListener("input", (e) => {
      const r = e.target;
      if (!r.dataset) return;
      if (r.dataset.setColor) {
        const key = r.dataset.setColor;
        const wrap = r.closest("[data-color-wrap]");
        if (wrap) wrap.classList.remove("off");
        const off = wrap && wrap.querySelector("[data-color-off]");
        if (off) off.classList.remove("on");
        if (!SETTINGS) SETTINGS = loadSettings();
        SETTINGS[key] = r.value;
        applyVisualSettings();
        return;
      }
      if (r.dataset.setRange) {
        const key = r.dataset.setRange;
        const it = specItem(key);
        previewSetting(key, Number(r.value));
        const out = document.querySelector('[data-set-val="' + key + '"]');
        if (out) out.textContent = r.value + ((it && it.unit) || "");
        // 底色浓度要即时可见（直接改 CSS 变量，不等落盘）
        if (key === "lightsTint") {
          if (!SETTINGS) SETTINGS = loadSettings();
          SETTINGS.lightsTint = Number(r.value);
          applyLightsTint();
        }
        return;
      }
      if (r.dataset.setText) {
        const key = r.dataset.setText;
        if (!SETTINGS) SETTINGS = loadSettings();
        SETTINGS[key] = r.value;
        applyVisualSettings();
      }
    });

    document.addEventListener("change", (e) => {
      const r = e.target;
      if (!r.dataset) return;
      if (r.dataset.setRange) setCfg(r.dataset.setRange, Number(r.value));
      else if (r.dataset.setSelect) setCfg(r.dataset.setSelect, r.value);
      else if (r.dataset.setText) setCfg(r.dataset.setText, r.value);
      else if (r.dataset.setColor) setCfg(r.dataset.setColor, r.value);
    });
  }

  /* ============================== 编排 ============================== */

  /** 其他 Codex 风格脚本在跑时避让 */
  function otherThemeActive() {
    const root = document.documentElement;
    return root.classList.contains("codex-theme") ||
      root.classList.contains("feishu-im-theme") ||
      root.classList.contains("idea-ide-theme") ||
      !!document.getElementById("v2ex-codex-theme") ||
      !!document.getElementById("linuxdo-codex-theme");
  }

  let scheduled = false;
  function scheduleApply() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      try {
        if (otherThemeActive()) {
          unmask();
          document.querySelector(".hpcx-main")?.remove();
          document.querySelector(".hpcx-rail")?.remove();
          return;
        }
        document.documentElement.classList.add(ROOT_CLASS);
        syncMode();
        render();
      } catch (err) {
        // 解析失败时绝不破坏原站：撤掉接管，回退原生页面
        console.error("[hupu-codex] 渲染失败，已回退原生页面", err);
        unmask();
        document.querySelector(".hpcx-main")?.remove();
        document.querySelector(".hpcx-rail")?.remove();
      }
    });
  }

  /*
   * 版块页的 $$data 在 <body> 末尾，正常情况下 DOMContentLoaded 时已经存在。
   * 但详情页是 Next.js：hydration 之后有可能晚一拍；网络慢时也可能先拿到
   * 不完整的首屏。所以只要「这次没拿到数据」就再试几次，拿到就停 ——
   * 比早前那个无条件 900ms 重渲染干净（不再白重画一遍整页）。
   */
  function retryUntilData() {
    let tries = 0;
    (function again() {
      if (RENDERED_WITH_DATA || tries++ >= 10) return;
      DATA_CACHE = null;      // 丢掉可能不完整的缓存，重新读
      scheduleApply();
      setTimeout(again, 150);
    })();
  }

  /**
   * 放手不管：把接管用的三个 class 全摘掉，原生页面完全恢复。
   * BOOT_CLASS 一定要一起摘 —— 否则一旦中途出错，页面会永远停在
   * 「原生被盖住、我们也没画」的空白状态，比不装脚本还糟。
   */
  function unmask() {
    document.documentElement.classList.remove(ROOT_CLASS, LOCK_CLASS, BOOT_CLASS, "hpcx-rail-open");
  }

  /* ============================== 软导航 ==============================
   *
   * 虎扑是多文档站点：点版块、点帖子、翻页都是整页跳转。整页跳转会创建一份新
   * 文档，而油猴只能在 document-start 注入脚本 —— 新文档从创建到第一次绘制可能
   * 只有 ~30ms，脚本还没来得及挂 BOOT/LOCK，那一小段画出来的就是虎扑原生页面。
   * 这个窗口在页面里没法再往前压。
   *
   * 所以脚本自己 UI 里的站内链接不再让浏览器换文档：fetch 回目标页 HTML、用
   * DOMParser 解析成一份游离文档（SRC），套同一套数据读取逻辑，在同一个文档里
   * 重画。文档不换，原生页面就没有机会露脸。地址栏用 pushState 同步，前进/后退
   * 也能用；解析不了或不支持的路由，退回原来的整页跳转。
   * ================================================================= */

  const DOC_URL = location.href;   // 物理 DOM 真正对应的地址（软导航不改 DOM）
  let VIEW_URL = DOC_URL;          // 当前展示的地址
  let VIEW_IS_DOC = true;          // 当前展示的是不是物理 DOM（软导航后为 false）
  let DOC_TITLE = null;            // 物理 DOM 的标题（软导航改过标题后要能还原）
  let LAST_URL = location.href;
  let NAV_SEQ = 0;

  /** 这个地址能不能软导航（同源 hupu + 脚本能解析的路径） */
  function softable(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return false; }
    if (u.origin !== location.origin) return false;
    if (!/(^|\.)hupu\.com$/i.test(u.hostname)) return false;
    const p = u.pathname.replace(/\/+$/, "") || "/";
    if (p === "/search") return false;                  // 搜索页解析不了，直接整页跳转
    if (p === "/") return true;
    if (/^\/\d+(?:-\d+)?\.html$/.test(p)) return true; // 帖子：/123.html、/123-2.html
    if (/^\/[\w-]+$/.test(p)) return true;              // 版块 / 分类（含 -postdate / -hot / -2）
    return false;
  }

  /**
   * 软导航：地址改成 url，同时在同一份文档里重画。
   * 任何一步出问题都退回 location.href（整页跳转，行为同以前）。
   */
  function softNav(url, opts) {
    opts = opts || {};
    if (otherThemeActive() || !softable(url)) { location.href = url; return; }

    let target;
    try { target = new URL(url, location.href).href; } catch { location.href = url; return; }
    if (target === VIEW_URL && !opts.force) return;    // 已经展示的就是这页
    if (opts.push !== false) {
      try { history.pushState(null, "", target); } catch { location.href = target; return; }
    }
    LAST_URL = location.href;

    const seq = ++NAV_SEQ;
    toastNow("正在打开 " + (new URL(target).pathname || "/") + " …");

    fetch(target, {
      credentials: "same-origin",
      headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
    })
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text().then((html) => ({ html: html, finalUrl: res.url || target }));
      })
      .then((res) => {
        if (seq !== NAV_SEQ) return;                     // 期间又点了一次，这次作废
        if (res.finalUrl !== location.href) {            // 跟随过重定向
          try { history.replaceState(null, "", res.finalUrl); } catch { /* ignore */ }
          LAST_URL = location.href;
        }
        const doc = new DOMParser().parseFromString(res.html, "text/html");
        const prevSrc = SRC, prevCache = DATA_CACHE;
        SRC = doc;
        DATA_CACHE = null;
        if (!isSupported(route())) {                     // 不支持的路由：还原，走整页跳转
          SRC = prevSrc; DATA_CACHE = prevCache;
          throw new Error("这个页面不接管主区");
        }
        if (doc.title) NATIVE_TITLE = doc.title;
        PAGE = null;
        try {
          render();                                      // 用 SRC（新文档）+ location（新地址）重画
          // render() 在拿不到数据时会摘掉 LOCK/BOOT、露出（物理 DOM 的）原生页面。
          // 软导航下那等于「地址变了、内容还是旧页」，不如退回整页跳转。
          if (!PAGE || !PAGE.data) throw new Error("没有解析出数据");
        } catch (err) {
          SRC = prevSrc; DATA_CACHE = prevCache;
          throw err;
        }
        const threadBox = document.querySelector(".hpcx-thread");
        if (threadBox) threadBox.scrollTop = 0;          // 新页面从头看起
        VIEW_URL = location.href;
        VIEW_IS_DOC = false;
      })
      .catch((err) => {
        if (seq !== NAV_SEQ) return;
        console.warn("[hupu-codex] 软导航失败，改用整页跳转：", err);
        location.href = target;
      });
  }

  /** 前进/后退：当前位置不是软导航自己切的，重新拉一份渲染 */
  function onUrlChange() {
    if (location.href === LAST_URL) return;
    LAST_URL = location.href;
    if (otherThemeActive()) return;
    if (location.href === DOC_URL) {
      SRC = document; DATA_CACHE = null; PAGE = null;
      NATIVE_TITLE = DOC_TITLE;
      VIEW_URL = DOC_URL; VIEW_IS_DOC = true;
      render();
      return;
    }
    if (softable(location.href)) softNav(location.href, { push: false });
    else location.reload();
  }

  function hookHistory() {
    if (hookHistory._bound) return;
    hookHistory._bound = true;
    ["pushState", "replaceState"].forEach((k) => {
      const orig = history[k];
      if (typeof orig !== "function") return;
      history[k] = function () {
        const ret = orig.apply(this, arguments);
        setTimeout(onUrlChange, 0);
        return ret;
      };
    });
    window.addEventListener("popstate", onUrlChange);
    window.addEventListener("hashchange", onUrlChange);
  }

  /**
   * 脚本自己画出来的界面（rail / 主区，都带 data-hpcx）里的站内链接走软导航。
   * 监听挂在 document 冒泡阶段、且在 bindRail 之后注册 —— 这样脚本自己的交互
   * （展开分类、切换排序等）先跑完并 preventDefault，这里靠 defaultPrevented
   * 跳过，不会抢掉它们。
   */
  function bindSoftLinks() {
    if (bindSoftLinks._bound) return;
    bindSoftLinks._bound = true;
    document.addEventListener("click", (e) => {
      if (e.defaultPrevented) return;
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a || !a.closest("[data-hpcx]")) return;
      if (a.target && a.target !== "_self") return;
      let u;
      try { u = new URL(a.href, location.href); } catch { return; }
      if (u.href === location.href) return;
      if (!softable(u.href)) return;
      e.preventDefault();
      softNav(u.href);
    });
  }

  /* ============================== 启动 ============================== */

  /**
   * 尽早把 rail 画出来。
   *
   * 既然原生页面已经被 BOOT 盖住了，总得让用户看到点东西 ——
   * 否则就是几百毫秒（网络慢时更长）的纯色空白。
   * 这时数据还没到，所以 rail 里只有导航骨架，分类/热榜等 $$data 到了再补。
   */
  function paintEarlyRail() {
    let tries = 0;
    (function kick() {
      if (!document.body) {
        // documentElement 已经有 class 了，body 一般紧接着就来
        if (tries++ < 300) return requestAnimationFrame(kick);
        return;
      }
      try {
        if (!document.querySelector(".hpcx-rail")) {
          ensureRail({ route: route(), nav: {}, data: null });
        }
      } catch { /* 早期渲染失败无所谓，后面 render() 会重来 */ }
    })();
  }

  function bootstrap() {
    if (!document.documentElement) {
      setTimeout(bootstrap, 0);
      return;
    }

    /*
     * 整个启动流程包一层 try/catch。
     *
     * 因为 BOOT_CLASS 一加上，原生页面就被盖住了：
     * 如果后面任何一步抛错（而且没跑到 domReady 的兜底），
     * 页面会永远停在「原生被盖住 + 我们也没画」的纯色空白 —— 比不装脚本还糟。
     * 所以无论哪里出错，都先 unmask() 把原生页面还回去。
     */
    try {
      bootstrapInner();
    } catch (err) {
      console.error("[hupu-codex] 启动失败，已回退原生页面", err);
      unmask();
      document.querySelector(".hpcx-main")?.remove();
      document.querySelector(".hpcx-rail")?.remove();
    }
  }

  function bootstrapInner() {
    injectStyle();
    if (!otherThemeActive()) {
      syncMode();
      document.documentElement.classList.add(ROOT_CLASS);

      /*
       * 先乐观地盖住原生页面。
       *
       * 版块页能不能接管，必须等 <body> 末尾的 $$data 才能判定 ——
       * 实测那已经是 400ms 以后了（真实网络更久）。这段时间如果不盖，
       * 看到的就是虎扑原样式，也就是「初次打开闪一下」。
       * 判定为不支持的路由时，render() 会把 BOOT_CLASS 摘掉，
       * 原生页面照旧显示（只是晚了几百毫秒）。
       */
      document.documentElement.classList.add(BOOT_CLASS);

      // 详情页看路径就能确定，不用等数据；版块页等 render() 再补 LOCK
      try {
        if (isSupported(route())) document.documentElement.classList.add(LOCK_CLASS);
      } catch { /* 数据还没到，DOMContentLoaded 时再判定 */ }
      applyFavicon();
      paintEarlyRail();
    }
    applyVisualSettings();

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !otherThemeActive()) applyFavicon();
    });

    bindLightbox();
    bindImgFallback();
    bindImgPreview();
    bindSettingsPanel();
    bindStealthKeys();
    bindSettingsKeys();
    bindPublish();
    bindRail();
    bindSoftLinks();   // 必须在 bindRail 之后：站内链接的软导航要让 rail 自己的交互先跑
    hookHistory();

    domReady().then(() => {
      scheduleApply();
      retryUntilData();

      // ⌘/Ctrl + K → 搜索
      window.addEventListener("keydown", (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
        if ((e.key || "").toLowerCase() !== "k") return;
        if (otherThemeActive()) return;
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "TEXTAREA" || tag === "INPUT") return;
        if (e.target && e.target.isContentEditable) return;
        e.preventDefault();
        e.stopPropagation();
        openSearch();
      }, true);
    });
  }

  bootstrap();
})();
