/**
 * 启动时序测试 —— 专治「初次打开闪一下虎扑原样式」。
 *
 * 为什么单独一个文件：
 *   jsdom 里脚本是「文档解析完之后」才 eval 的，$$data 早就有了，
 *   所以无论怎么写都测不出这个 bug。
 *   真实场景是 @run-at document-start：脚本先跑，
 *   而虎扑把整页数据放在 **<body> 末尾**的 <script> 里，要几百毫秒后才存在。
 *
 * 所以这里：把 HTML **分块慢慢发**（前半段立刻发，含 $$data 的后半段延迟发），
 * 再用 addInitScript（等价于 document-start）跑脚本，
 * 同时每 10ms 采样一次“原生容器是否可见 / 是否已经接管”，
 * 最后断言：被接管的页面上，原生容器**一次都不能被看见**。
 *
 * 用法: node timing.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(__dirname, "fixtures");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find((p) => fs.existsSync(p));

/** 后半段（含 $$data / __NEXT_DATA__）的发送延迟，模拟真实网络 */
const BODY_DELAY = Number(process.env.BODY_DELAY || 400);

const ROUTES = [
  { path: "/topic-daily", file: "topic-daily.html", takeover: true, label: "版块页（列表）" },
  { path: "/topic-daily-2", file: "hp_topic-daily-2.html", takeover: true, label: "版块页第 2 页" },
  { path: "/all-gambia", file: "hp_all-gambia.html", takeover: true, label: "分类页" },
  { path: "/", file: "hp_home.html", takeover: true, label: "首页" },
  { path: "/642400850.html", file: "post.html", takeover: true, label: "帖子详情页" },
  { path: "/642400850-2.html", file: "p642400850-2.html", takeover: true, label: "帖子第 2 页" },
  { path: "/search?q=%E4%B9%94%E4%B8%B9", file: "hp_search.html", takeover: false, label: "搜索页（不接管）" }
];

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { console.log("    ✓ " + name); pass++; }
  else { console.log("    ✗ " + name + (extra ? " → " + extra : "")); failures.push(name); fail++; }
}

/** 分块慢发：documentElement 立刻出现，数据脚本（body 末尾）延迟到 */
function slowServe(file) {
  return (req, res) => {
    const html = fs.readFileSync(path.join(FIXTURES, file), "utf8");
    const cut = Math.floor(html.length * 0.5);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.write(html.slice(0, cut));
    setTimeout(() => res.end(html.slice(cut)), BODY_DELAY);
  };
}

(async () => {
  if (!CHROME) { console.log("找不到本机 Chrome/Edge，跳过"); process.exit(0); }

  const byPath = new Map(ROUTES.map((r) => [new URL(r.path, "http://l").pathname, r]));
  const srv = http.createServer((q, r) => {
    const u = new URL(q.url, "http://l");
    const route = byPath.get(u.pathname);
    if (!route) { r.writeHead(404); r.end(); return; }
    slowServe(route.file)(q, r);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.route("**/*", (rt) =>
    rt.request().url().startsWith("http://127.0.0.1") ? rt.continue() : rt.abort());

  // 采样器：必须在页面脚本之前就开始跑
  await ctx.addInitScript({
    content: `
      window.__t0 = performance.now();
      window.__tl = [];
      (function sample() {
        const de = document.documentElement;
        if (de) {
          const n = document.querySelector("#container") || document.querySelector("#__next");
          let nativeVisible = false;
          if (n && n.firstElementChild) {
            const s = getComputedStyle(n);
            nativeVisible = s.display !== "none" && s.visibility !== "hidden";
          }
          window.__tl.push({
            t: Math.round(performance.now() - window.__t0),
            boot: de.classList.contains("hpcx-boot"),
            locked: de.classList.contains("hpcx-locked"),
            rail: !!document.querySelector(".hpcx-rail"),
            main: !!document.querySelector(".hpcx-main"),
            nativeVisible,
            // 还有哪些「不是我们的」body 子节点没被藏住？
            // 虎扑的 rc-menu / antd 弹层是挂在 body 上的 portal（不在 #container 里），
            // 早期只藏 #container，结果启动时主区里会浮现原生弹层残片。
            leak: document.body
              ? Array.from(document.body.children).filter((el) =>
                  !el.hasAttribute("data-hpcx") && getComputedStyle(el).display !== "none"
                ).map((el) => el.id || el.className || el.tagName).slice(0, 3)
              : []
          });
        }
        if (performance.now() - window.__t0 < 3000) setTimeout(sample, 10);
      })();
    `
  });
  const SCRIPT_PATH = process.env.SCRIPT || path.join(ROOT, "hupu-codex.user.js");
  await ctx.addInitScript({ content: fs.readFileSync(SCRIPT_PATH, "utf8") });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  console.log(`\n（HTML 后半段延迟 ${BODY_DELAY}ms 发送，模拟真实网络）`);

  for (const route of ROUTES) {
    console.log("\n▶ " + route.label);
    errors.length = 0;
    await page.goto(`http://127.0.0.1:${port}${route.path}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    const tl = await page.evaluate(() => window.__tl);
    if (!tl.length) { check("采到时间线", false, "没有采样点"); continue; }

    const first = (pred) => (tl.find(pred) || {}).t;

    if (route.takeover) {
      // 被接管的页面：原生容器一次都不能露出来
      const leaked = tl.filter((x) => x.nativeVisible);
      check("原生容器全程不可见（没有闪原样式）",
        leaked.length === 0,
        leaked.length ? `在 ${leaked[0].t}ms 露出来，共 ${leaked.length} 个采样点` : "");

      // 从第 60ms 起就该已经有 rail（而不是空白）
      const railT = first((x) => x.rail);
      check("rail 很早就画出来了（< " + (BODY_DELAY + 60) + "ms）",
        railT != null && railT < BODY_DELAY + 60, "rail 出现在 " + railT + "ms");

      // 启动期间 / 接管后，原生 portal（挂在 body 上的弹层）也不能露
      const leaks = tl.filter((x) => x.leak && x.leak.length);
      check("body 上的原生节点（含 rc-menu 弹层）全程被藏住",
        leaks.length === 0,
        leaks.length ? `在 ${leaks[0].t}ms 露出 ${JSON.stringify(leaks[0].leak)}` : "");

      // 数据到齐后必须进入接管态
      const lockT = first((x) => x.locked && x.main);
      check("数据到齐后完成接管", lockT != null, "locked+main 出现在 " + lockT + "ms");

      // 接管之后 boot 必须摘掉（否则多一层 hidden 白挂着）
      const last = tl[tl.length - 1];
      check("收尾时 boot 已摘掉、lock 生效", last.boot === false && last.locked === true && last.main === true,
        JSON.stringify({ boot: last.boot, locked: last.locked, main: last.main }));
    } else {
      // 不被接管的页面：boot 必须最终摘掉，原生内容要能回来
      const last = tl[tl.length - 1];
      check("最终把原生页面还回来（boot 摘掉、内容可见）",
        last.boot === false && last.nativeVisible === true,
        JSON.stringify({ boot: last.boot, nativeVisible: last.nativeVisible }));

      // 而且不该永久盖住
      const bootT = first((x) => x.boot === false && x.rail);
      check("遮盖不会一直挂着", bootT != null && bootT < 1500, "摘掉 boot 于 " + bootT + "ms");
    }
  }

  check("全程无 JS 报错", errors.length === 0, errors.join(" | "));

  await browser.close();
  srv.close();
  console.log("\n────────────────────────────");
  console.log("通过 " + pass + " / 失败 " + fail);
  if (failures.length) console.log("失败项: " + failures.join(", "));
  process.exit(fail ? 1 : 0);
})();
