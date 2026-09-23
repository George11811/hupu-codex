/**
 * 真实浏览器验收（jsdom 验不了的部分）：布局、CSS 生效、响应式降级、图片失败兜底。
 * 用本机 Chrome 跑，资源全部走本地，外站请求 abort。
 * 用法: node browser.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright-core");

const FIXTURES = path.join(__dirname, "fixtures");
const ROOT = path.join(__dirname, "..");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find((p) => fs.existsSync(p));

const PAGES = {
  "/topic-daily": "topic-daily.html",
  "/642400850.html": "post.html",
  "/642395849.html": "p642395849.html"
};

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { console.log("    ✓ " + name); pass++; }
  else { console.log("    ✗ " + name + (extra ? " → " + extra : "")); failures.push(name); fail++; }
}

(async () => {
  const srv = http.createServer((q, r) => {
    const u = new URL(q.url, "http://l");

    // 慢图：用来测「大图还没下载完」时的预览定位（占位尺寸估计）
    if (u.pathname === "/slow-image.svg") {
      setTimeout(() => {
        r.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
        r.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">' +
              '<rect width="400" height="300" fill="#37a"/></svg>');
      }, 600);
      return;
    }

    /*
     * 模拟「已登录」：?login=1 时把 post.html 的 euid 改成非空
     * （euid 是详情页唯一的登录信号，login.js 里已验证过这套改法）。
     * 注意必须挂在 /642400850.html 这个路径上 —— 脚本只按 pathname 判路由，
     * 换个路径名会被当成「不支持的路由」而不接管主区。
     */
    if (u.pathname === "/642400850.html" && u.searchParams.get("login") === "1") {
      let h = fs.readFileSync(path.join(FIXTURES, "post.html"), "utf8");
      const from = '"euid":""', to = '"euid":"190905797171683"';
      if (h.split(from).length - 1 !== 1) throw new Error("euid 锚点不止一处，测试要更新");
      r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      r.end(h.replace(from, to));
      return;
    }

    const f = PAGES[u.pathname];
    if (!f) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    r.end(fs.readFileSync(path.join(FIXTURES, f)));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
  await ctx.route("**/*", (rt) => rt.request().url().startsWith("http://127.0.0.1") ? rt.continue() : rt.abort());
  await ctx.addInitScript({ content: fs.readFileSync(process.env.SCRIPT || path.join(ROOT, "hupu-codex.user.js"), "utf8") });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  async function go(url, theme) {
    await page.goto(base + url, { waitUntil: "domcontentloaded" });
    if (theme !== undefined) {
      await page.evaluate((t) => {
        if (t === null) localStorage.removeItem("hpcx:settings");
        else localStorage.setItem("hpcx:settings", JSON.stringify(t));
      }, theme);
      await page.reload({ waitUntil: "domcontentloaded" });
    }
    await page.waitForTimeout(400);
  }

  /* ---------- 布局 ---------- */
  console.log("\n▶ 布局（真实计算样式）");
  await go("/topic-daily", null);
  {
    const m = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const r = (s) => q(s).getBoundingClientRect();
      const main = q(".hpcx-main");
      return {
        railW: Math.round(r(".hpcx-rail").width),
        mainLeft: Math.round(r(".hpcx-main").left),
        mainRight: Math.round(r(".hpcx-main").right),
        vw: window.innerWidth,
        codeW: Math.round(r(".hpcx-code-col").width),
        gridCols: getComputedStyle(main).gridTemplateColumns,
        bodyScrollH: document.documentElement.scrollHeight,
        innerH: window.innerHeight,
        threadScrollable: q(".hpcx-thread").scrollHeight > q(".hpcx-thread").clientHeight,
        nativeHidden: getComputedStyle(q("#container")).display,
        moreCursor: getComputedStyle(document.querySelector(".hpcx-rail-section .hpcx-note")).cursor
      };
    });
    check("rail 宽度 = 默认 300", m.railW === 300, "实际 " + m.railW);
    check("main 从 rail 右边开始", Math.abs(m.mainLeft - m.railW) <= 1, "mainLeft=" + m.mainLeft);
    check("main 右缘贴住视口（没有横向溢出）", Math.abs(m.mainRight - m.vw) <= 2, m.mainRight + " vs " + m.vw);
    check("代码面板宽度 = 默认 440", m.codeW === 440, "实际 " + m.codeW);
    check("grid 两列", /1fr|px/.test(m.gridCols) && m.gridCols.split(" ").length === 2, m.gridCols);
    check("页面本身不滚动（滚动发生在 .hpcx-thread 里，像 app 而不是网页）",
      m.bodyScrollH <= m.innerH + 2, "body " + m.bodyScrollH + " vs " + m.innerH);
    check("帖子列表区可独立滚动", m.threadScrollable);
    check("原生 #container 被隐藏", m.nativeHidden === "none", m.nativeHidden);
    check("「共 N 页」是说明文字不是按钮（cursor 非 pointer）", m.moreCursor !== "pointer", m.moreCursor);
  }

  /* ---------- 明暗 token ---------- */
  console.log("\n▶ 明暗主题");
  {
    const dark = await page.evaluate(() => getComputedStyle(document.querySelector(".hpcx-main")).backgroundColor);
    check("深色 main 背景 #181818", dark === "rgb(24, 24, 24)", dark);
    await go("/topic-daily", { theme: "light" });
    const light = await page.evaluate(() => ({
      main: getComputedStyle(document.querySelector(".hpcx-main")).backgroundColor,
      title: getComputedStyle(document.querySelector(".hpcx-row-title")).color,
      panel: getComputedStyle(document.querySelector(".hpcx-code-col")).backgroundColor
    }));
    check("浅色 main 背景 #f4f4f4", light.main === "rgb(244, 244, 244)", light.main);
    check("浅色正文是深色字", light.title === "rgb(27, 28, 30)", light.title);
    check("浅色代码面板白底", light.panel === "rgb(255, 255, 255)", light.panel);
  }

  /* ---------- 图片失败兜底 ---------- */
  console.log("\n▶ 图片加载失败兜底（本测试故意断外网）");
  await go("/642395849.html", {});
  {
    const info = await page.evaluate(() => ({
      fallbacks: document.querySelectorAll(".hpcx-img-fallback").length,
      // 真正「加载完了但没图」的才算破图；lazy 且还没进视口的 img 不算
      trulyBroken: [...document.querySelectorAll(".hpcx-cooked img, .hpcx-turn-user-bubble img")]
        .filter((i) => i.complete && i.naturalWidth === 0).length,
      lazyOk: [...document.querySelectorAll(".hpcx-cooked img")].filter((i) => i.loading === "lazy").length,
      sample: (document.querySelector(".hpcx-img-fallback") || {}).textContent || ""
    }));
    check("失败图片被替换成可点提示", info.fallbacks > 0, "fallback=" + info.fallbacks);
    check("没有残留的破图 img（已加载完但无图）", info.trulyBroken === 0, "剩余 " + info.trulyBroken);
    check("正文图都加了 lazy", info.lazyOk > 0, "lazy=" + info.lazyOk);
    check("提示文案正确", /看原图/.test(info.sample), info.sample);
  }

  /* ---------- 图片悬停预览 + 灯箱 ---------- */
  console.log("\n▶ 悬停预览的位置（不能固定贴在某个角落）");
  {
    /*
     * 用户报的 bug：预览永远出现在右下角。
     * 原因：CSS 里写死了 right:18px;bottom:18px，根本没做定位。
     *
     * 这里把测试图用 position:fixed 钉在视口里指定位置，
     * 这样缩略图的 rect 完全可控，可以断言预览确实被摆到了它旁边。
     */
    const GAP_MIN = 8, GAP_MAX = 20;   // 代码里的 gap = 12，留点余量

    /** 在正文里放一张已知视口位置的图；origin 为空则不设 data-origin */
    async function placeImg(rect, originUrl) {
      await page.evaluate(({ rect, originUrl }) => {
        const host = document.querySelector(".hpcx-cooked") || document.querySelector(".hpcx-turn-user-bubble");
        host.innerHTML = "";
        const mk = (w, h, c) => "data:image/svg+xml," + encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c}"/></svg>`);
        const img = document.createElement("img");
        img.src = mk(200, 150, "#3a7");
        if (originUrl) img.dataset.origin = originUrl;
        // 钉住视口位置，并绕开 .hpcx-cooked img 的 max-width 限制
        img.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
          `width:${rect.width}px;height:${rect.height}px;max-width:none;max-height:none;z-index:5`;
        host.appendChild(img);
      }, { rect, originUrl });
      await page.waitForTimeout(120);
    }

    const geom = () => page.evaluate(() => {
      const i = document.querySelector(".hpcx-cooked img");
      const p = document.querySelector(".hpcx-imgprev");
      if (!i || !p) return null;
      const ir = i.getBoundingClientRect(), pr = p.getBoundingClientRect();
      return {
        img: { l: ir.left, t: ir.top, r: ir.right, b: ir.bottom, w: ir.width, h: ir.height },
        prev: { l: pr.left, t: pr.top, r: pr.right, b: pr.bottom, w: pr.width, h: pr.height },
        on: p.classList.contains("on"),
        vw: document.documentElement.clientWidth,
        vh: document.documentElement.clientHeight
      };
    });

    const BIG = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#a37"/></svg>');

    await go("/642395849.html", {});

    // —— 场景 1：图在左边，右侧有地方 → 预览应该贴在图右边 ——
    await placeImg({ left: 320, top: 140, width: 200, height: 150 }, BIG);
    await page.hover(".hpcx-cooked img");
    await page.waitForTimeout(250);
    {
      const g = await geom();
      check("预览出现在视口内", g && g.on && g.prev.l >= 0 && g.prev.t >= 0 &&
        g.prev.r <= g.vw && g.prev.b <= g.vh,
        g ? JSON.stringify({ l: g.prev.l, t: g.prev.t, r: g.prev.r, b: g.prev.b, vw: g.vw, vh: g.vh }) : "没渲染");
      const gap = g.prev.l - g.img.r;
      check("预览贴在图右侧（gap ≈ 12px）", gap >= GAP_MIN && gap <= GAP_MAX,
        `img.right=${Math.round(g.img.r)} prev.left=${Math.round(g.prev.l)} gap=${Math.round(gap)}`);
      check("垂直方向与图对齐（不是贴着顶/底边）",
        Math.abs((g.prev.t + g.prev.h / 2) - (g.img.t + g.img.h / 2)) <= 4,
        `imgCenter=${Math.round(g.img.t + g.img.h / 2)} prevCenter=${Math.round(g.prev.t + g.prev.h / 2)}`);
      // 这一条直接锁死这次的 bug：旧代码会贴在右下角
      const atBottomRight = Math.abs(g.prev.b - (g.vh - 18)) <= 6 && Math.abs(g.prev.r - (g.vw - 18)) <= 6;
      check("没有贴在右下角", !atBottomRight,
        `prev.right=${Math.round(g.prev.r)} prev.bottom=${Math.round(g.prev.b)}`);
    }

    // —— 场景 2：图靠右，右侧放不下 → 应该翻到左边，并垂直夹进视口 ——
    await placeImg({ left: 1200, top: 700, width: 200, height: 150 }, BIG);
    await page.hover(".hpcx-cooked img");
    await page.waitForTimeout(250);
    {
      const g = await geom();
      const gap = g.img.l - g.prev.r;
      check("右侧放不下时翻到图的左侧", gap >= GAP_MIN && gap <= GAP_MAX,
        `prev.right=${Math.round(g.prev.r)} img.left=${Math.round(g.img.l)} gap=${Math.round(gap)}`);
      check("底部放不下时垂直夹进视口", g.prev.b <= g.vh - 4,
        `prev.bottom=${Math.round(g.prev.b)} vh=${g.vh}`);
    }

    // —— 场景 3：图在右下角附近，两侧都放不下 → 至少不能越界 ——
    await placeImg({ left: 640, top: 620, width: 210, height: 160 }, BIG);
    await page.hover(".hpcx-cooked img");
    await page.waitForTimeout(250);
    {
      const g = await geom();
      check("两侧都放不下时夹在视口内，不越界",
        g.prev.l >= 0 && g.prev.t >= 0 && g.prev.r <= g.vw && g.prev.b <= g.vh,
        JSON.stringify({ l: Math.round(g.prev.l), t: Math.round(g.prev.t), r: Math.round(g.prev.r), b: Math.round(g.prev.b) }));
    }

    // —— 场景 4：大图还没下载完时就要摆对位置（否则盒子是 0×0，会跑到左上角） ——
    await placeImg({ left: 320, top: 200, width: 200, height: 150 }, "http://127.0.0.1:" + port + "/slow-image.svg");
    await page.hover(".hpcx-cooked img");
    await page.waitForTimeout(120);   // 故意早于慢图返回（600ms）
    {
      const g = await geom();
      const gap = g.prev.l - g.img.r;
      check("大图未加载完时位置已经是对的（用缩略图比例占位）",
        gap >= GAP_MIN && gap <= GAP_MAX, `gap=${Math.round(gap)} (l=${Math.round(g.prev.l)} r=${Math.round(g.img.r)})`);
      check("大图未加载完时预览有合理尺寸（不是 0×0）", g.prev.w >= 40 && g.prev.h >= 30,
        `${Math.round(g.prev.w)}x${Math.round(g.prev.h)}`);
    }
    await page.waitForTimeout(700);   // 等慢图到齐，再确认位置被校正且没跑飞
    {
      const g = await geom();
      const gap = g.prev.l - g.img.r;
      check("大图到齐后重新校正，仍在图旁边", g.on && gap >= GAP_MIN && gap <= GAP_MAX,
        `gap=${Math.round(gap)} on=${g.on}`);
    }

    // —— 鼠标移开要收起 ——
    await page.mouse.move(20, 880);
    await page.waitForTimeout(300);
    check("鼠标移开后预览收起", await page.evaluate(() => {
      const p = document.querySelector(".hpcx-imgprev");
      return !p || !p.classList.contains("on");
    }));
  }

  console.log("\n▶ 缩略图尺寸 / 灯箱");
  {
    // 用 data URI 造一张能加载的图，避免依赖外网
    await page.evaluate(() => {
      const png = "data:image/svg+xml," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#3a7"/></svg>');
      const img = document.createElement("img");
      img.src = png;
      img.dataset.origin = png;
      document.querySelector(".hpcx-turn-user-bubble").appendChild(img);
    });
    await page.waitForTimeout(200);
    const box = await page.evaluate(() => {
      const i = document.querySelector(".hpcx-cooked img, .hpcx-turn-user-bubble img");
      const r = i.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    });
    check("缩略图受 max-width/height 约束（<=300x200）", box.w <= 300 && box.h <= 200, box.w + "x" + box.h);

    await page.click(".hpcx-cooked img, .hpcx-turn-user-bubble img");
    await page.waitForTimeout(200);
    check("点图开灯箱", await page.evaluate(() => !!document.querySelector(".hpcx-lightbox")));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    check("Esc 关灯箱", await page.evaluate(() => !document.querySelector(".hpcx-lightbox")));
  }

  /* ---------- rail 交互（真实浏览器） ---------- */
  console.log("\n▶ rail 点击委托（真实浏览器）");
  await go("/topic-daily", {});
  {
    /*
     * 两个容易回归的点：
     *   1. rail 的点击是「文档级委托」的，处理函数里如果读 e.currentTarget
     *      会拿到 document（不是 rail），一点分类箭头就会去 document.innerHTML = ...
     *      直接抛 HierarchyRequestError。
     *   2. 分类箭头包在 <a href> 里，必须 preventDefault，不能真的跳走。
     */
    const before = page.url();
    const cat = page.locator(".hpcx-cat").first();
    await cat.locator("[data-cat-toggle]").click();
    await page.waitForTimeout(200);
    const opened = await cat.evaluate((n) => n.classList.contains("open"));
    check("点分类箭头能展开，且不会跳页", opened && page.url() === before,
      "open=" + opened + " url=" + page.url());

    // 再点几次必须能正常开/关（监听器不能叠加）
    await cat.locator("[data-cat-toggle]").click();
    await page.waitForTimeout(150);
    const closed = await cat.evaluate((n) => n.classList.contains("open"));
    check("再点一次能收起（一次点一次生效）", closed === false, "open=" + closed);

    // 明暗切换只切一次
    const t0 = await page.evaluate(() => document.documentElement.classList.contains("hpcx-light"));
    await page.click("[data-mode-toggle]");
    await page.waitForTimeout(150);
    const t1 = await page.evaluate(() => document.documentElement.classList.contains("hpcx-light"));
    check("明暗按钮只切一次主题", t1 !== t0, t0 + " -> " + t1);

    // 点分类名字应该真的跳转（别把所有点击都 preventDefault 了）
    await page.evaluate(() => {
      const head = document.querySelector(".hpcx-cat-head");
      head.setAttribute("href", "?touched=1");
    });
    await page.locator(".hpcx-cat-head").first().click();
    await page.waitForTimeout(300);
    check("点分类名字（链接）会正常跳转", page.url().includes("touched=1"), page.url());
  }

  /* ---------- 拖拽调宽 ---------- */
  console.log("\n▶ 两栏拖拽调宽（双击复位）");
  await go("/topic-daily", {});
  {
    const before = await page.evaluate(() => ({
      rail: Math.round(document.querySelector(".hpcx-rail").getBoundingClientRect().width),
      panel: Math.round(document.querySelector(".hpcx-code-col").getBoundingClientRect().width)
    }));

    // rail 往右拖 60px → 变宽 60
    const rz = await page.locator(".hpcx-rail > .hpcx-resizer").boundingBox();
    await page.mouse.move(rz.x + rz.width / 2, rz.y + 200);
    await page.mouse.down();
    await page.mouse.move(rz.x + rz.width / 2 + 60, rz.y + 200, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    // panel 往左拖 80px → 变宽 80
    const pz = await page.locator(".hpcx-code-col > .hpcx-resizer").boundingBox();
    await page.mouse.move(pz.x + pz.width / 2, pz.y + 200);
    await page.mouse.down();
    await page.mouse.move(pz.x + pz.width / 2 - 80, pz.y + 200, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await page.evaluate(() => ({
      rail: Math.round(document.querySelector(".hpcx-rail").getBoundingClientRect().width),
      panel: Math.round(document.querySelector(".hpcx-code-col").getBoundingClientRect().width),
      saved: JSON.parse(localStorage.getItem("hpcx:settings"))
    }));
    check("拖 rail 右缘变宽 ~60px", Math.abs(after.rail - (before.rail + 60)) <= 3, before.rail + " -> " + after.rail);
    check("拖 panel 左缘变宽 ~80px", Math.abs(after.panel - (before.panel + 80)) <= 3, before.panel + " -> " + after.panel);
    check("宽度写进了 localStorage", after.saved.railWidth === after.rail && after.saved.panelWidth === after.panel,
      JSON.stringify(after.saved));

    // 双击复位
    await page.dblclick(".hpcx-rail > .hpcx-resizer");
    await page.dblclick(".hpcx-code-col > .hpcx-resizer");
    await page.waitForTimeout(150);
    const reset = await page.evaluate(() => ({
      rail: Math.round(document.querySelector(".hpcx-rail").getBoundingClientRect().width),
      panel: Math.round(document.querySelector(".hpcx-code-col").getBoundingClientRect().width)
    }));
    check("双击复位回默认 300 / 440", reset.rail === 300 && reset.panel === 440, JSON.stringify(reset));
  }

  /* ---------- 亮评区：视觉上要能和普通回复区分开 ---------- */
  console.log("\n▶ 亮评区（真实计算样式）");
  await go("/642400850.html", {});
  {
    const read = () => page.evaluate(() => {
      const box = document.querySelector(".hpcx-lights");
      const body = document.querySelector(".hpcx-lights-body");
      const head = document.querySelector(".hpcx-lights-head");
      const inside = box && box.querySelector(".hpcx-turn-agent");
      const outside = [...document.querySelectorAll(".hpcx-turn-agent")].find((n) => !n.closest(".hpcx-lights"));
      const cs = (n, p) => (n ? getComputedStyle(n)[p] : "(无)");
      // Chrome 把 color-mix() 算成 "color(srgb r g b / a)"，不再是 rgba()，
      // 所以自己把 alpha 抽出来，断言就不依赖具体序列化格式
      const alphaOf = (v) => {
        const m1 = String(v).match(/\/\s*([\d.]+)\s*\)/);
        if (m1) return parseFloat(m1[1]);
        const m2 = String(v).match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/);
        return m2 ? parseFloat(m2[1]) : 1;
      };
      return {
        bg: cs(box, "backgroundColor"),
        bgAlpha: alphaOf(cs(box, "backgroundColor")),
        border: cs(box, "borderTopColor"),
        radius: cs(box, "borderRadius"),
        insideBorder: cs(inside, "borderLeftColor"),
        outsideBorder: cs(outside, "borderLeftColor"),
        bodyDisplay: cs(body, "display"),
        headCursor: cs(head, "cursor"),
        chev: cs(box && box.querySelector(".hpcx-lights-chev"), "transform"),
        boxW: box ? Math.round(box.getBoundingClientRect().width) : 0,
        bodyTurns: body ? body.querySelectorAll(".hpcx-turn-agent").length : 0,
        bodyH: body ? Math.round(body.getBoundingClientRect().height) : 0
      };
    });

    const a = await read();
    check("亮评区有独立底色（半透明混色，浓度≈默认 12%）",
      a.bgAlpha > 0.06 && a.bgAlpha < 0.2, `alpha=${a.bgAlpha} (${a.bg})`);
    check("亮评区有边框和圆角（看得出是一个区块）",
      a.border !== "rgba(0, 0, 0, 0)" && parseFloat(a.radius) >= 8, `border=${a.border} radius=${a.radius}`);
    check("亮评区占满正文宽度", a.boxW > 500, "宽 " + a.boxW);
    check("区内的楼层左边线颜色与区外不同（一眼能分出边界）",
      a.insideBorder !== a.outsideBorder, `区内 ${a.insideBorder} / 区外 ${a.outsideBorder}`);
    check("标题行是手型光标（暗示可点）", a.headCursor === "pointer", a.headCursor);
    check("默认展开、body 里有 17 条", a.bodyDisplay !== "none" && a.bodyTurns === 17,
      `display=${a.bodyDisplay} turns=${a.bodyTurns}`);
    // 箭头方向必须跟状态对得上：展开 ▼、折叠 ▶（别写反了）
    const isRotated = (tf) => tf !== "none" && !/matrix\(1, 0, 0, 1/.test(tf);
    check("展开时箭头是 ▼（旋转过）", isRotated(a.chev), a.chev);

    // 折叠
    await page.click("[data-lights-toggle]");
    await page.waitForTimeout(250);
    const b = await read();
    check("折叠后 body 收起来（高度归零）", b.bodyDisplay === "none" || b.bodyH === 0,
      `display=${b.bodyDisplay} h=${b.bodyH}`);
    check("折叠后区块本身还在（标题仍可见）", b.boxW > 500, "宽 " + b.boxW);
    check("折叠时箭头是 ▶（未旋转，和展开状态相反）",
      isRotated(b.chev) !== isRotated(a.chev), `展开 ${a.chev} / 折叠 ${b.chev}`);

    await page.click("[data-lights-toggle]");
    await page.waitForTimeout(250);
    check("再点展开", (await read()).bodyTurns === 17);

    // 换底色 + 浓度
    await page.evaluate(() => {
      localStorage.setItem("hpcx:settings", JSON.stringify({ lightsBg: "#3366ff", lightsTint: 30 }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const c = await read();
    check("换底色 + 30% 浓度 → 颜色变了而且更浓",
      c.bg !== a.bg && c.bgAlpha > a.bgAlpha + 0.1,
      `默认 alpha=${a.bgAlpha} / 自定义 alpha=${c.bgAlpha}`);

    // 无底色
    await page.evaluate(() => {
      localStorage.setItem("hpcx:settings", JSON.stringify({ lightsBg: "", lightsTint: 30 }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    const d = await read();
    check("选「无」后背景完全透明（但区块和标题还在）",
      d.bgAlpha === 0 && d.boxW > 500, `alpha=${d.bgAlpha} 宽=${d.boxW}`);
  }

  /* ---------- 回帖输入框（真实浏览器） ---------- */
  console.log("\n▶ 回帖输入框（已登录）");
  await go("/642400850.html?login=1", {});
  {
    const info = await page.evaluate(() => {
      const bar = document.querySelector(".hpcx-composer-bar");
      const send = bar.querySelector('.hpcx-send[data-md="reply"]');
      const copy = bar.querySelector('.hpcx-send[data-md="copy"]');
      const cs = (n) => (n ? getComputedStyle(n).backgroundColor : "");
      const r = (n) => (n ? n.getBoundingClientRect() : { width: 0, height: 0 });
      const wrap = document.querySelector(".hpcx-composer-wrap");
      return {
        hasSend: !!send,
        sendText: send ? send.textContent.trim() : "",
        sendBg: cs(send),
        copyBg: cs(copy),
        hint: document.querySelector(".hpcx-composer-hint").textContent.trim(),
        overflow: wrap.scrollWidth - wrap.clientWidth,
        editorH: Math.round(r(document.querySelector(".hpcx-editor")).height)
      };
    });
    check("已登录时输入框里有「回复」按钮", info.hasSend && info.sendText === "回复", info.sendText);
    check("「回复」是主按钮（实心底），复制是次要按钮",
      info.sendBg !== "rgba(0, 0, 0, 0)" && info.copyBg === "rgba(0, 0, 0, 0)",
      `send=${info.sendBg} copy=${info.copyBg}`);
    check("提示改成 Ctrl+Enter 发表", /发表/.test(info.hint), info.hint);
    check("按钮没把工具栏挤到溢出", info.overflow <= 0, "溢出 " + info.overflow + "px");
    check("输入区高度正常（没被压扁）", info.editorH >= 40, "高 " + info.editorH);

    // 引用条：点某楼「回复」后换成 quoting 态
    await page.hover(".hpcx-turn-agent");
    await page.click('.hpcx-act[data-act="reply"][data-floor="1"]');
    await page.waitForTimeout(200);
    const q = await page.evaluate(() => {
      const t = document.querySelector(".hpcx-composer-target");
      return {
        quoting: t.classList.contains("quoting"),
        text: t.textContent.trim(),
        cancel: !!t.querySelector('[data-md="cancel-quote"]'),
        overflow: t.scrollWidth - t.clientWidth
      };
    });
    check("点楼层「回复」→ 顶部切到引用条", q.quoting && /楼/.test(q.text), q.text);
    check("引用条有取消按钮", q.cancel);
    check("引用条太长也不撑破布局", q.overflow <= 1, "溢出 " + q.overflow + "px");

    const body = await page.evaluate(() => document.querySelector(".hpcx-editor").textContent);
    check("引用交给接口，正文里只留 @", /^@/.test(body) && !/^>/.test(body),
      JSON.stringify(body.slice(0, 40)));

    await page.click('[data-md="cancel-quote"]');
    await page.waitForTimeout(150);
    check("点 ✕ 回到普通标题",
      await page.evaluate(() => !document.querySelector(".hpcx-composer-target").classList.contains("quoting")));
  }

  console.log("\n▶ 回帖输入框（未登录）");
  await go("/642400850.html", {});
  {
    const info = await page.evaluate(() => ({
      send: !!document.querySelector('.hpcx-send[data-md="reply"]'),
      loginLink: !!document.querySelector(".hpcx-composer-bar a[href*='passport']"),
      hint: document.querySelector(".hpcx-composer-hint").textContent.trim()
    }));
    check("未登录没有发表按钮，改成登录引导", !info.send && info.loginLink, JSON.stringify(info));
    check("提示说明只能本地草稿", /未登录/.test(info.hint), info.hint);
  }

  /* ---------- 响应式 ---------- */
  console.log("\n▶ 响应式降级");
  await go("/topic-daily", {});
  {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(250);
    const mid = await page.evaluate(() => ({
      panel: getComputedStyle(document.querySelector(".hpcx-code-col")).display,
      cols: getComputedStyle(document.querySelector(".hpcx-main")).gridTemplateColumns.split(" ").length
    }));
    check("<=1180px 收起代码面板", mid.panel === "none", mid.panel);
    check("<=1180px 主区单列", mid.cols === 1, "cols=" + mid.cols);

    await page.setViewportSize({ width: 760, height: 900 });
    await page.waitForTimeout(250);
    const narrow = await page.evaluate(() => {
      const rail = document.querySelector(".hpcx-rail").getBoundingClientRect();
      return { railLeft: Math.round(rail.left), menuVisible: getComputedStyle(document.querySelector(".hpcx-menu-btn")).display, mainLeft: Math.round(document.querySelector(".hpcx-main").getBoundingClientRect().left) };
    });
    check("<=860px rail 收成抽屉（移出视口）", narrow.railLeft < 0, "left=" + narrow.railLeft);
    check("<=860px 主区占满宽度", narrow.mainLeft === 0, "left=" + narrow.mainLeft);
    check("汉堡按钮出现", narrow.menuVisible !== "none", narrow.menuVisible);

    await page.click(".hpcx-menu-btn");
    await page.waitForTimeout(400);
    check("点汉堡展开抽屉", await page.evaluate(() =>
      document.querySelector(".hpcx-rail").getBoundingClientRect().left >= 0));
  }

  /* ---------- 伪装视图铺满 ---------- */
  console.log("\n▶ 应急伪装视图");
  await page.setViewportSize({ width: 1600, height: 1000 });
  await go("/642400850.html", {});
  {
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const b = await page.evaluate(() => {
      const box = document.querySelector(".hpcx-boss");
      const r = box.getBoundingClientRect();
      return {
        rect: { w: Math.round(r.width), h: Math.round(r.height), t: Math.round(r.top), l: Math.round(r.left) },
        railHidden: getComputedStyle(document.querySelector(".hpcx-rail")).display,
        mainHidden: getComputedStyle(document.querySelector(".hpcx-main")).display,
        termRows: getComputedStyle(box).gridTemplateRows,
        forumTextVisible: /乔丹/.test(document.body.innerText.replace(
          document.querySelector(".hpcx-boss").innerText, ""))
      };
    });
    check("伪装视图铺满视口", b.rect.w === 1600 && b.rect.h === 1000, JSON.stringify(b.rect));
    check("rail / main 在伪装视图下隐藏", b.railHidden === "none" && b.mainHidden === "none");
    check("三段式布局（标签栏 / 编辑器 / 终端）", b.termRows.split(" ").length === 3, b.termRows);
    check("伪装时看不到帖子正文（不可能一眼被看穿的兜底）", b.forumTextVisible === false);
  }

  /* ---------- 页面透明度 + 侧边栏模式（真实指针离开事件） ---------- */
  console.log("\n▶ 页面透明度 / 侧边栏模式");
  await go("/topic-daily", { pageAlpha: 40, sidebarMask: true });
  {
    /*
     * 透明度只该作用在**脚本自绘的两块**（rail + 主区）上：
     * 伪装视图、设置面板必须始终保持不透明 —— 否则滑杆拖到 20% 之后
     * 连面板本身都看不清，没法再调回来（这正是把 opacity 挂在
     * 这两个容器而不是 <html>/<body> 上的原因，所以这几条断言就是那条设计决定本身）。
     */
    const t = await page.evaluate(() => {
      const cs = (s) => getComputedStyle(document.querySelector(s));
      return {
        main: cs(".hpcx-main").opacity,
        rail: cs(".hpcx-rail").opacity,
        alpha: document.documentElement.style.getPropertyValue("--hpcx-chrome-alpha").trim(),
        html: getComputedStyle(document.documentElement).opacity,
        body: getComputedStyle(document.body).opacity,
        bossExists: !!document.querySelector(".hpcx-boss")
      };
    });
    check("透明度滑杆 40% → rail / 主区 opacity 0.4", t.main === "0.4" && t.rail === "0.4", JSON.stringify(t));
    check("CSS 变量按百分比换算（40 → 0.4）", t.alpha === "0.4", t.alpha);
    check("html / body 本身不受影响（只有脚本自绘的界面变淡）",
      t.html === "1" && t.body === "1", JSON.stringify(t));

    /*
     * 用真实鼠标移动来触发指针离开（page.mouse.move 是浏览器自己派发的可信事件）。
     * 不能自己 dispatch 一个 PointerEvent("pointerleave")：那是 0,0 坐标的合成事件，
     * 脚本会明确忽略它（否则「藏好」和「放回来」会互相打架、伪装视图闪一下就没）。
     */
    await page.mouse.move(800, 400);
    await page.mouse.move(800, -5);            // 移出视口上边（往地址栏去）
    await page.waitForTimeout(250);
    const hidden = await page.evaluate(() => {
      const cs = (s) => getComputedStyle(document.querySelector(s));
      const box = document.querySelector(".hpcx-boss");
      return {
        on: document.documentElement.classList.contains("hpcx-boss-on"),
        rail: cs(".hpcx-rail").display,
        main: cs(".hpcx-main").display,
        bossOpacity: getComputedStyle(box).opacity,
        boss: Math.round(box.getBoundingClientRect().width)
      };
    });
    check("指针离开页面区域 → 自动进伪装视图", hidden.on && hidden.rail === "none" && hidden.main === "none",
      JSON.stringify(hidden));
    check("伪装视图不受透明度影响（必须不透明，否则一眼就看穿）", hidden.bossOpacity === "1", hidden.bossOpacity);
    check("伪装视图仍然铺满视口", hidden.boss === 1600, "宽 " + hidden.boss);

    // 回到页面 → 自动恢复
    await page.mouse.move(800, 400);
    await page.waitForTimeout(250);
    const back = await page.evaluate(() => ({
      on: document.documentElement.classList.contains("hpcx-boss-on"),
      main: getComputedStyle(document.querySelector(".hpcx-main")).display,
      opacity: getComputedStyle(document.querySelector(".hpcx-main")).opacity
    }));
    check("指针回到页面 → 自动恢复，透明度设置还在",
      !back.on && back.main !== "none" && back.opacity === "0.4", JSON.stringify(back));

    // 再离开一次：验证不是「只生效一次」
    await page.mouse.move(800, -5);
    await page.waitForTimeout(250);
    check("再离开一次仍然会藏", await page.evaluate(() =>
      document.documentElement.classList.contains("hpcx-boss-on")));
    await page.mouse.move(800, 400);
    await page.waitForTimeout(200);
  }

  // 关掉「回到页面自动恢复」→ 回来也不退出，得自己按应急键
  await go("/topic-daily", { sidebarMask: true, sidebarMaskRestore: false });
  {
    await page.mouse.move(800, 400);
    await page.mouse.move(800, -5);
    await page.waitForTimeout(250);
    check("关掉自动恢复 → 离开页面照样藏", await page.evaluate(() =>
      document.documentElement.classList.contains("hpcx-boss-on")));
    await page.mouse.move(800, 400);
    await page.waitForTimeout(250);
    const still = await page.evaluate(() => ({
      on: document.documentElement.classList.contains("hpcx-boss-on"),
      main: getComputedStyle(document.querySelector(".hpcx-main")).display
    }));
    check("关掉自动恢复 → 指针回到页面仍停在伪装视图", still.on && still.main === "none",
      JSON.stringify(still));
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    check("关掉自动恢复时应急键仍然能退出", await page.evaluate(() =>
      !document.documentElement.classList.contains("hpcx-boss-on")));
  }

  // 关掉侧边栏模式之后，同样的指针离开不该有任何反应
  await go("/topic-daily", { pageAlpha: 100, sidebarMask: false });
  {
    await page.mouse.move(800, 400);
    await page.mouse.move(800, -5);
    await page.waitForTimeout(250);
    const off = await page.evaluate(() => ({
      on: document.documentElement.classList.contains("hpcx-boss-on"),
      opacity: getComputedStyle(document.querySelector(".hpcx-main")).opacity
    }));
    check("关掉侧边栏模式 → 离开页面不伪装", !off.on, JSON.stringify(off));
    check("透明度回到 100% → 完全不透明", off.opacity === "1", off.opacity);
  }

  check("全程无 JS 报错", errors.length === 0, errors.join(" | "));

  await browser.close();
  srv.close();
  console.log("\n────────────────────────────");
  console.log("通过 " + pass + " / 失败 " + fail);
  if (failures.length) console.log("失败项: " + failures.join(", "));
  process.exit(fail ? 1 : 0);
})();
