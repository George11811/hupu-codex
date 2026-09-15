/**
 * 登录态显示测试。
 *
 * 背景（用户报的 bug）：登录后切到版块（专区）就显示「未登录」。
 * 原因是虎扑几套前端把 isLogin 放在完全不同的位置：
 *   首页 / 分类页   $$data.isLogin
 *   版块页          $$data.topic.isLogin      ← 之前只读了第一个，所以这里漏了
 *   帖子详情页      没有 isLogin，只有 pageProps.euid（未登录是空串）
 *
 * 我们没法在测试里真登录，所以改成「把真实页面的数据改成已登录的样子」：
 * 在 fixture 的 HTML 里做精确字符串替换（并断言替换确实生效，
 * 否则将来站点改格式时测试会静默失真）。
 *
 * 每个用例都同时验两面：
 *   · 已登录时必须显示「我的虎扑」，不能出现「未登录」
 *   · 未登录时必须显示「未登录 · 去登录」
 *
 * 用法: node login.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const SCRIPT = fs.readFileSync(process.env.SCRIPT || path.join(__dirname, "..", "hupu-codex.user.js"), "utf8");
const FIXTURES = path.join(__dirname, "fixtures");

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); console.log("    ✓ " + name); pass++; }
  catch (e) { console.log("    ✗ " + name + " → " + e.message); failures.push(name); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(msg + " (期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a) + ")");
}

/**
 * 把 fixture 改成「已登录」。patches 是 [from, to] 列表；
 * 每个 from 必须恰好出现一次，否则直接抛错（防止测试静默失效）。
 */
function loggedInHtml(file, patches) {
  let html = fs.readFileSync(path.join(FIXTURES, file), "utf8");
  for (const [from, to] of patches) {
    const n = html.split(from).length - 1;
    if (n !== 1) throw new Error(`${file}: 期望 "${from}" 出现 1 次，实际 ${n} 次`);
    html = html.replace(from, to);
  }
  return html;
}

/** 版块页：isLogin 在 $$data.topic 里 */
const TOPIC_PATCH = ['{"topic":{"isLogin":false', '{"topic":{"isLogin":true'];
/** 首页 / 分类页：顶层和 pageData 里各一份 */
const HOME_PATCHES = [
  ['{"env":"prod","isLogin":false', '{"env":"prod","isLogin":true'],
  ['"pageData":{"isLogin":false', '"pageData":{"isLogin":true']
];
/** 详情页：没有 isLogin，靠 pageProps.euid */
const NEXT_PATCH = ['"euid":""', '"euid":"190905797171683"'];

async function render(file, url, htmlOverride) {
  const errors = [];
  const vc = new VirtualConsole();
  const ignorable = (m) => /Not implemented: navigation/.test(m);
  vc.on("jsdomError", (e) => { if (!ignorable(e.message)) errors.push(e.message); });
  vc.on("error", (...a) => { const m = a.join(" "); if (!ignorable(m)) errors.push(m); });

  const html = htmlOverride != null ? htmlOverride : fs.readFileSync(path.join(FIXTURES, file), "utf8");
  const dom = new JSDOM(html, {
    url, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc
  });
  dom.window.prompt = () => "x";
  dom.window.open = () => {};
  dom.window.eval(SCRIPT);
  await new Promise((r) => setTimeout(r, 60));
  return { doc: dom.window.document, w: dom.window, errors };
}

/** rail 底部显示的账号文案 */
function footLabel(doc) {
  const el = doc.querySelector(".hpcx-rail-foot-user .hpcx-label");
  return el ? el.textContent.trim() : "(缺失)";
}
function footHref(doc) {
  const el = doc.querySelector(".hpcx-rail-foot-user");
  return el ? el.getAttribute("href") : "";
}

(async function main() {
  console.log("\n▶ 版块页 /topic-daily（isLogin 在 $$data.topic 里）");
  {
    const a = await render("topic-daily.html", "https://bbs.hupu.com/topic-daily",
      loggedInHtml("topic-daily.html", [TOPIC_PATCH]));
    check("已登录时显示「我的虎扑」", () => {
      eq(footLabel(a.doc), "我的虎扑", "文案");
      ok(!/未登录/.test(a.doc.querySelector(".hpcx-rail-foot").textContent), "不能出现「未登录」");
      ok(a.doc.querySelector(".hpcx-main"), "页面正常接管");
    });
    a.w.close();

    const b = await render("topic-daily.html", "https://bbs.hupu.com/topic-daily");
    check("未登录时显示「未登录 · 去登录」", () => {
      eq(footLabel(b.doc), "未登录 · 去登录", "文案");
      ok(/passport/.test(footHref(b.doc)), "链接指向登录页: " + footHref(b.doc));
    });
    b.w.close();
  }

  console.log("\n▶ 版块页第 2 页 / 排序变体（同一套 $$data.topic）");
  for (const [file, url] of [
    ["hp_topic-daily-2.html", "https://bbs.hupu.com/topic-daily-2"],
    ["hp_tdpostdate.html", "https://bbs.hupu.com/topic-daily-postdate"],
    ["hp_tdhot.html", "https://bbs.hupu.com/topic-daily-hot"],
    ["hp_nba.html", "https://bbs.hupu.com/nba"]
  ]) {
    const r = await render(file, url, loggedInHtml(file, [TOPIC_PATCH]));
    check(url + " 已登录时显示「我的虎扑」", () => {
      eq(footLabel(r.doc), "我的虎扑", "文案");
    });
    r.w.close();
  }

  console.log("\n▶ 首页 / 分类页（isLogin 在顶层和 pageData 里）");
  for (const [file, url] of [
    ["hp_home.html", "https://bbs.hupu.com/"],
    ["hp_all-gambia.html", "https://bbs.hupu.com/all-gambia"]
  ]) {
    const a = await render(file, url, loggedInHtml(file, HOME_PATCHES));
    check(url + " 已登录时显示「我的虎扑」", () => {
      eq(footLabel(a.doc), "我的虎扑", "文案");
      ok(!/未登录/.test(a.doc.querySelector(".hpcx-rail-foot").textContent), "不能出现「未登录」");
    });
    a.w.close();

    const b = await render(file, url);
    check(url + " 未登录时显示「未登录 · 去登录」", () => {
      eq(footLabel(b.doc), "未登录 · 去登录", "文案");
    });
    b.w.close();
  }

  console.log("\n▶ 帖子详情页（没有 isLogin，只有 pageProps.euid）");
  for (const [file, url] of [
    ["post.html", "https://bbs.hupu.com/642400850.html"],
    ["p642400850-2.html", "https://bbs.hupu.com/642400850-2.html"],
    ["p642395849.html", "https://bbs.hupu.com/642395849.html"]
  ]) {
    const a = await render(file, url, loggedInHtml(file, [NEXT_PATCH]));
    check(url + " 已登录时显示「我的虎扑」", () => {
      eq(footLabel(a.doc), "我的虎扑", "文案");
      ok(!/未登录/.test(a.doc.querySelector(".hpcx-rail-foot").textContent), "不能出现「未登录」");
    });
    a.w.close();

    const b = await render(file, url);
    check(url + " 未登录时显示「未登录 · 去登录」", () => {
      eq(footLabel(b.doc), "未登录 · 去登录", "文案");
    });
    b.w.close();
  }

  console.log("\n▶ 没有登录信号的页面（搜索页）→ 中性文案，不能说错");
  {
    const r = await render("hp_search.html", "https://bbs.hupu.com/search?q=%E4%B9%94%E4%B8%B9");
    check("搜索页不该断定「未登录」", () => {
      eq(r.doc.querySelector(".hpcx-main"), null, "本来就不接管");
      const label = footLabel(r.doc);
      eq(label, "我的虎扑", "中性文案");
      ok(!/未登录/.test(r.doc.querySelector(".hpcx-rail-foot").textContent),
        "$$data 里没有 isLogin 时必须保持中性，而不是猜「未登录」");
    });
    r.w.close();
  }

  console.log("\n▶ careList 标题要跟着登录态变");
  {
    /*
     * 域名 叫 careListInfo（“关注”），但未登录时它**照样有数据**，
     * 而原生页面在未登录时这个位置只显示「登录后的世界更精彩 [登录]」——
     * 所以未登录时不能把它标成「我关注的帖子」。
     */
    const a = await render("hp_home.html", "https://bbs.hupu.com/",
      loggedInHtml("hp_home.html", HOME_PATCHES));
    check("已登录 → 「我关注的帖子」", () => {
      const titles = [...a.doc.querySelectorAll(".hpcx-rail-section > span")].map((n) => n.textContent.trim());
      ok(titles.includes("我关注的帖子"), "rail 分区: " + titles.join("/"));
    });
    a.w.close();

    const b = await render("hp_home.html", "https://bbs.hupu.com/");
    check("未登录 → 「帖子推荐」（不能写「我关注的」）", () => {
      const titles = [...b.doc.querySelectorAll(".hpcx-rail-section > span")].map((n) => n.textContent.trim());
      ok(titles.includes("帖子推荐"), "rail 分区: " + titles.join("/"));
      ok(!titles.includes("我关注的帖子"), "未登录时不能声称是「我关注的」");
    });
    b.w.close();
  }

  console.log("\n▶ 三态语义自检（直接改 __NEXT_DATA__ 里的字段）");
  {
    /*
     * 详情页的两个信号：
     *   pageProps.euid            未登录是 ""
     *   pageProps.detail.user.puid  未登录是 "0"
     * 下面把两个字段分别置成各种组合，验证判定与「矛盾时倾向已登录」的策略。
     * patches 必须显式写全 —— 之前用了一句 if (!from) 自动补刀，
     * 结果把「未登录」那一例也改成了已登录，测试自己先矛盾了。
     */
    const E = '"euid":"","side"';
    const cases = [
      {
        name: "euid 非空 + puid 非 0 → 已登录",
        patches: [[E, '"euid":"190905797171683","side"'], ['"user":{"puid":"0"}', '"user":{"puid":"42102540"}']],
        expect: "我的虎扑"
      },
      {
        name: "euid 空 + puid 为 0（真实未登录页）→ 未登录",
        patches: [],
        expect: "未登录 · 去登录"
      },
      {
        name: "euid 非空但 puid 为 0（矛盾）→ 倾向已登录",
        patches: [[E, '"euid":"190905797171683","side"']],
        expect: "我的虎扑"
      },
      {
        name: "euid 缺失、只靠 puid 非 0 → 已登录",
        patches: [[E, '"side"'], ['"user":{"puid":"0"}', '"user":{"puid":"42102540"}']],
        expect: "我的虎扑"
      },
      {
        name: "euid 缺失、puid 为 0 → 未登录",
        patches: [[E, '"side"']],
        expect: "未登录 · 去登录"
      },
      {
        name: "两个信号都缺失 → 不猜，中性文案",
        patches: [[E, '"side"'], ['"user":{"puid":"0"}', '"user":{}']],
        expect: "我的虎扑"
      }
    ];

    for (const c of cases) {
      const r = await render("post.html", "https://bbs.hupu.com/642400850.html",
        loggedInHtml("post.html", c.patches));
      check(c.name, () => eq(footLabel(r.doc), c.expect, "文案"));
      r.w.close();
    }
  }

  console.log("\n────────────────────────────");
  console.log("通过 " + pass + " / 失败 " + fail);
  if (failures.length) console.log("失败项: " + failures.join(", "));
  process.exit(fail ? 1 : 0);
})();
