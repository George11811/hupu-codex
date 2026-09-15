/**
 * 正文图片尺寸 / 图片保真测试。
 *
 * 用户报告：「配置里的修改正文图片尺寸对虎扑自带的表情图片无效」。
 * 查下来是三件事叠在一起：
 *
 *   1. 【真 bug】CSS 里有一条
 *        .hpcx-cooked img.hpcx-img-sm { max-width:180px; max-height:180px }
 *      给「小图」写死了像素值 —— 那些图**完全不看用户设的尺寸**。
 *      而标记小图的 markSmallImages() 是在图片还没加载时跑的（读 naturalWidth），
 *      命中与否取决于图片当时在不在内存缓存里，同一个页面刷新两次结果都可能不同。
 *
 *   2. 【语义】尺寸设置是 max-width / max-height，也就是**上限**。
 *      虎扑自带的表情图只有 46~132px，本来就比上限小 ——
 *      上限再怎么调也不会把它们变大，所以这类图「不响应」是数学上的必然，不是 bug。
 *
 *   3. 【保真】虎扑的正文 HTML 里存在两种会让人踩坑的 <img>：
 *        · src 用单引号：   <img src='...' />
 *        · url 里带 >：     <img src="...?thumbnail/2000x>/quality/50/..."/>
 *      前者旧实现只认 src=" 会当“没有 src”把图删掉；后者会被 [^>]* 提前截断。
 *      两种都会让图片**静默消失**。
 *
 * 这个文件把上面三件事都钉住。关键前提：本地要按虎扑 URL 里的尺寸提示
 * 返回对应大小的假图，否则 naturalWidth 全是 0，什么都量不出来。
 *
 * 用法: node images.js
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

const PAGE = { path: "/642400850-2.html", file: "p642400850-2.html" };  // 含表情尺寸的小图
const PAGE_Q = { path: "/642400850.html", file: "post.html" };          // 含单引号 + url 带 >

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { console.log("    ✓ " + name); pass++; }
  else { console.log("    ✗ " + name + (extra ? " → " + extra : "")); failures.push(name); fail++; }
}

/** 虎扑图片 URL 里带着尺寸提示，服务端会按它返回对应大小的图 */
function sizeFromUrl(u) {
  let w = 800, h = 600;
  const o = u.match(/_o_w_(\d+)_h_(\d+)/);
  if (o) { w = +o[1]; h = +o[2]; }
  else { const m = u.match(/_w_(\d+)_h_(\d+)_/); if (m) { w = +m[1]; h = +m[2]; } }
  const cap = u.match(/resize,w_(\d+)/);
  if (cap && w > +cap[1]) { h = Math.round(h * (+cap[1]) / w); w = +cap[1]; }
  return { w: Math.max(w, 1), h: Math.max(h, 1) };
}
function fakeImage(u) {
  const { w, h } = sizeFromUrl(u);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
    '"><rect width="' + w + '" height="' + h + '" fill="#48a"/></svg>';
}

/*
 * 直接从 fixture 的 __NEXT_DATA__ 里数出正文该有多少张图。
 *
 * 这里**故意不复用**脚本里的 cleanContent —— 实现和测试一起错就看不出来了。
 * 扫描标签时要按引号配对（HTML 解析器不会在引号内部断标签），
 * 所以用 (?:"[^"]*"|'[^']*'|[^>"'])* 而不是 [^>]*。
 */
const TAG_RE = /<img(?=[\s/>])(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
const SRC_RE = /[ \t\r\n\f]src[ \t\r\n\f]*=[ \t\r\n\f]*(?:"([^"]*)"|'([^']*)')/i;

function expectedImages(file) {
  const s = fs.readFileSync(path.join(FIXTURES, file), "utf8");
  const m = s.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  const d = JSON.parse(m[1]).props.pageProps.detail;

  /*
   * 只算「楼层自己的正文」。
   * 引用卡片里的图**故意不渲染成 <img>** —— 脚本会把它换成 [图片] 占位符
   * （避免同一个图在页面上出现两次），所以那些不能计入期望值。
   */
  const parts = [d.thread.content || ""];
  for (const r of (d.replies || {}).list || []) parts.push(r.content || "");
  for (const l of d.lights || []) parts.push(l.content || "");

  const urls = [];
  for (const c of parts) {
    for (const tag of c.match(TAG_RE) || []) {
      const mm = tag.match(SRC_RE);
      if (mm) urls.push(mm[1] != null ? mm[1] : mm[2]);
    }
  }
  return urls;
}

(async () => {
  if (!CHROME) { console.log("找不到本机 Chrome/Edge，跳过"); process.exit(0); }

  const srv = http.createServer((q, r) => {
    const u = new URL(q.url, "http://l");
    const hit = [PAGE, PAGE_Q].find((p) => p.path === u.pathname);
    if (hit) {
      r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      r.end(fs.readFileSync(path.join(FIXTURES, hit.file)));
      return;
    }
    r.writeHead(404); r.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const base = "http://127.0.0.1:" + port;

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, colorScheme: "dark" });
  await ctx.route("**/*", (rt) => {
    const u = rt.request().url();
    if (u.startsWith("http://127.0.0.1")) return rt.continue();
    // 图片用「按 URL 尺寸伪造的 SVG」顶替（naturalWidth 才可控），
    // 其余外站资源（站点自己的 js）直接 abort
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(u)) {
      return rt.fulfill({
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
        body: fakeImage(u)
      });
    }
    return rt.abort();
  });
  await ctx.addInitScript({ content: fs.readFileSync(process.env.SCRIPT || path.join(ROOT, "hupu-codex.user.js"), "utf8") });

  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // 外站资源被 abort 会产生 Failed to load resource，和脚本无关
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text());
  });

  async function load(url, settings) {
    await page.goto(base + url, { waitUntil: "domcontentloaded" });
    await page.evaluate((s) => {
      if (s) localStorage.setItem("hpcx:settings", JSON.stringify(s));
      else localStorage.removeItem("hpcx:settings");
    }, settings || null);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
  }

  async function measure() {
    // 选择器必须和 CSS 里管尺寸的那一组一致：正文 + 主楼气泡 + 引用卡片
    return page.evaluate(() => [...document.querySelectorAll(
      ".hpcx-cooked img, .hpcx-turn-user-bubble img, .hpcx-quote-body img"
    )].map((i) => {
      const r = i.getBoundingClientRect();
      const s = getComputedStyle(i);
      return {
        src: i.getAttribute("src") || "",
        nw: i.naturalWidth, nh: i.naturalHeight,
        rw: Math.round(r.width), rh: Math.round(r.height),
        maxW: s.maxWidth, cls: String(i.className)
      };
    }));
  }

  /* ---------- 1. 图片一张都不能少 ---------- */
  console.log("\n▶ 图片保真（单引号 / url 带 > 都不能把图吃掉）");
  {
    const expect = expectedImages(PAGE_Q.file);
    const expectSet = [...new Set(expect)];
    check("测试自己的期望值有效（能从数据里解析出图片）", expectSet.length > 5,
      "解析出 " + expectSet.length + " 张");

    await load(PAGE_Q.path);
    const got = await measure();
    const gotSet = [...new Set(got.map((g) => g.src))];
    const missing = expectSet.filter((u) => !gotSet.includes(u));
    if (missing.length) {
      console.log("      丢失 " + missing.length + " 张: " +
        missing.map((u) => u.split("/").pop().slice(0, 52)).join(" | "));
    }
    check("数据里的每张图都渲染出来了（一张不丢）", missing.length === 0,
      `数据去重后 ${expectSet.length} 张，页面渲染 ${got.length} 张（去重 ${gotSet.length} 张）`);
    check("渲染的图不比数据里少", gotSet.length >= expectSet.length,
      `渲染去重 ${gotSet.length} vs 数据去重 ${expectSet.length}`);

    /*
     * 逐条计数必须完全一致。
     * 光比集合是看不出来的：虎扑同一张贴图会在多条回复/亮评里重复出现，
     * 只丢其中一次的话集合依然是完整的 —— 而那正是单引号 src 被吐掉时的表现。
     */
    const tally = (arr) => arr.reduce((m, u) => (m[u] = (m[u] || 0) + 1, m), {});
    const eTally = tally(expect), gTally = tally(got.map((g) => g.src));
    const countDiff = [...new Set([...Object.keys(eTally), ...Object.keys(gTally)])]
      .filter((k) => (eTally[k] || 0) !== (gTally[k] || 0));
    check("每张图出现的次数都对得上（不多不少）", countDiff.length === 0,
      `期望 ${expect.length} 条 / 渲染 ${got.length} 条` +
      (countDiff.length ? "，差异: " + countDiff.map((k) =>
        `${eTally[k] || 0}->${gTally[k] || 0} ${k.split("/").pop().slice(0, 46)}`).join(" | ") : ""));

    const singleUrl = expect.find((u) => u.indexOf("1733305081968_o_w_107_h_132") >= 0);
    check("单引号 src='...' 的那张图在页面上",
      !!singleUrl && gotSet.some((u) => u.indexOf("1733305081968_o_w_107_h_132") >= 0),
      "数据里" + (singleUrl ? "有" : "没有") + "，页面上 " +
        got.filter((g) => /1733305/.test(g.src)).length + " 张");

    const gtUrl = expect.find((u) => u.indexOf("thumbnail/2000x>") >= 0);
    check("src 里带 > 的那张图在页面上",
      !!gtUrl && gotSet.some((u) => u.indexOf("thumbnail/2000x>") >= 0),
      "数据里" + (gtUrl ? "有" : "没有") + "，页面上 " +
        got.filter((g) => /2000x>/.test(g.src)).length + " 张");

    check("没有空的 img（被误删的残留）", got.filter((g) => !g.src).length === 0);
  }

  /* ---------- 2. 尺寸设置对每张图都生效 ---------- */
  console.log("\n▶ 尺寸设置对所有正文图生效（含表情）");
  {
    await load(PAGE.path, { thumbWidth: 120, thumbHeight: 90 });
    const small = await measure();
    const over = small.filter((i) => i.rw > 121 || i.rh > 91);
    check("所有正文图都 ≤ 上限(120x90)", over.length === 0,
      over.map((i) => `${i.nw}x${i.nh}→${i.rw}x${i.rh}`).join(", "));

    const hardCoded = small.filter((i) => i.maxW !== "min(100%, 120px)");
    check("没有图被硬编码尺寸架空设置", hardCoded.length === 0,
      hardCoded.map((i) => `maxWidth=${i.maxW}`).join(", "));

    await load(PAGE.path, { thumbWidth: 300, thumbHeight: 200 });
    const big = await measure();
    check("默认设置下也没有图越界", big.every((i) => i.rw <= 301 && i.rh <= 201),
      big.map((i) => `${i.rw}x${i.rh}`).join(", "));

    // 自然尺寸超过上限的图，必须跟着设置变
    const changed = [], stuck = [];
    big.forEach((a) => {
      const b = small.find((x) => x.src === a.src && x.nw === a.nw);
      if (!b) return;
      if (!(a.nw > 121 || a.nh > 91)) return;
      if (a.rw !== b.rw || a.rh !== b.rh) changed.push(a); else stuck.push(a);
    });
    check("超过上限的图全部跟着设置变了", stuck.length === 0 && changed.length > 0,
      `变了 ${changed.length} 张` + (stuck.length
        ? `，没变 ${stuck.length} 张: ${stuck.map((i) => `${i.nw}x${i.nh}`).join(", ")}` : ""));

    // 表情尺度（高度 91~180px）—— 正是以前被 hpcx-img-sm 硬编码 180px 架空的区间
    const emojiScale = big.filter((i) => i.nh > 91 && i.nh <= 180);
    const responded = emojiScale.filter((a) => {
      const b = small.find((x) => x.src === a.src && x.nw === a.nw);
      return b && (a.rw !== b.rw || a.rh !== b.rh);
    });
    check("「表情尺寸区间(高度 91~180px)」的图现在也听话了",
      emojiScale.length > 0 && responded.length === emojiScale.length,
      `共 ${emojiScale.length} 张，响应 ${responded.length} 张` +
      (emojiScale.length ? `（自然尺寸 ${emojiScale.map((i) => `${i.nw}x${i.nh}`).join(", ")}）` : ""));

    // 上限语义：比上限小的图保持原样，不会被放大
    const tiny = big.filter((i) => i.nw <= 120 && i.nh <= 200);
    check("小于上限的图保持自然尺寸（上限不会放大图）",
      tiny.every((i) => Math.abs(i.rw - i.nw) <= 1 && Math.abs(i.rh - i.nh) <= 1),
      tiny.map((i) => `${i.nw}x${i.nh}→${i.rw}x${i.rh}`).join(", "));

    /*
     * 回归：旧版会给「小图」加一个 hpcx-img-sm 类，CSS 里给它写死了 180x180。
     * 而那个类到底加不加，取决于图片在标记时是否已在内存缓存里（一场 raced）——
     * 也就是说重现这个 bug 靠运气。这里干脆**手动把那个类补上**，
     * 模拟当时“运气好命中了”的情况，看尺寸还会不会听设置的。
     * 只要 CSS 里还有那条硬编码规则，下面这条就会挂。
     */
    await page.evaluate(() => {
      document.querySelectorAll(".hpcx-cooked img, .hpcx-turn-user-bubble img, .hpcx-quote-body img")
        .forEach((i) => i.classList.add("hpcx-img-sm"));
    });
    await page.waitForTimeout(200);
    const marked = await measure();
    check("就算被加上旧版的 hpcx-img-sm 类，尺寸依然听设置的",
      marked.every((i) => i.rw <= 301 && i.rh <= 201 && i.maxW === "min(100%, 300px)"),
      marked.filter((i) => i.maxW !== "min(100%, 300px)" || i.rw > 301 || i.rh > 201)
        .map((i) => `${i.nw}x${i.nh}→${i.rw}x${i.rh} maxW=${i.maxW}`).join(", "));
  }

  check("全程无 JS 报错", errors.length === 0, errors.join(" | "));

  await browser.close();
  srv.close();
  console.log("\n────────────────────────────");
  console.log("通过 " + pass + " / 失败 " + fail);
  if (failures.length) console.log("失败项: " + failures.join(", "));
  process.exit(fail ? 1 : 0);
})();
