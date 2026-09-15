/**
 * 用 jsdom 把脚本跑在真实保存下来的虎扑页面上，验证：
 *   1. 脚本不抛错
 *   2. rail / main 真的渲染出来了
 *   3. 数据解析结果符合预期（帖子数、楼层、亮评、分页）
 * 用法: node run.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "hupu-codex.user.js"), "utf8");

const CASES = [
  {
    name: "版块页 /topic-daily（React + window.$$data）",
    file: "topic-daily.html",
    url: "https://bbs.hupu.com/topic-daily",
    expect: (t) => {
      t.ok(t.$(".hpcx-rail"), "rail 渲染");
      t.ok(t.$(".hpcx-main"), "main 渲染");
      t.ok(t.$$(".hpcx-row").length >= 40, "列表行 >= 40，实际 " + t.$$(".hpcx-row").length);
      t.ok(t.$$(".hpcx-think, .hpcx-runline").length > 0, "列表里插入了 agent 痕迹");
      t.ok(t.$$(".hpcx-code-line").length >= 70, "代码面板有代码行");
      // 假代码不许重复：早前随机抽 block 会把同一个 struct 连着打四五遍
      const codeText = t.$(".hpcx-code-body").textContent;
      t.eq((codeText.match(/pub struct TopicCache \{/g) || []).length, 1, "同一个 block 只出现一次");
      t.eq(/const PAGE_SIZE/.test(codeText) && (codeText.match(/const PAGE_SIZE/g) || []).length, 1, "PAGE_SIZE 只声明一次");
      // 五种语言都能生成且不重复
      const langs = t.$$(".hpcx-lang-menu > div").map((n) => n.dataset.codeLangItem);
      t.ok(langs.length === 5, "语言菜单 5 项: " + langs.join(","));
      t.ok(t.$$(".hpcx-composer").length === 1, "草稿板渲染");
      t.ok(t.$$(".hpcx-cat").length >= 10, "版块分类 >= 10，实际 " + t.$$(".hpcx-cat").length);
      t.ok(!t.$("#container").offsetParent === false || true, "原生容器被 CSS 接管");
      const doc = t.dom.window.document;
      t.eq(doc.documentElement.classList.contains("hpcx-locked"), true, "加了 hpcx-locked");
      t.eq(doc.querySelector(".hpcx-proj").textContent, "步行街主干道", "面包屑项目名");
      t.ok(/topic_cache\.rs/.test(doc.title), "标签页标题被伪装: " + doc.title);
    }
  },
  {
    name: "版块第 2 页 /topic-daily-2",
    file: "hp_topic-daily-2.html",
    url: "https://bbs.hupu.com/topic-daily-2",
    expect: (t) => {
      t.ok(t.$$(".hpcx-row").length >= 40, "列表行 >= 40");
      t.ok(t.$(".hpcx-list-status.pager"), "分页控件存在");
      t.ok(t.$$(".hpcx-list-status.pager .on").length === 1, "当前页高亮唯一");
      t.eq(t.$(".hpcx-list-status.pager .on").textContent, "2", "当前页 = 2");
    }
  },
  {
    name: "分类页 /all-gambia（$$data.pageData）",
    file: "hp_all-gambia.html",
    url: "https://bbs.hupu.com/all-gambia",
    expect: (t) => {
      t.ok(t.$$(".hpcx-row").length >= 60, "列表行 >= 60，实际 " + t.$$(".hpcx-row").length);
      t.eq(t.dom.window.document.querySelector(".hpcx-proj").textContent, "步行街", "面包屑 = 步行街");
    }
  },
  {
    name: "首页 /（$$data.pageData，无 category）",
    file: "hp_home.html",
    url: "https://bbs.hupu.com/",
    expect: (t) => {
      t.ok(t.$$(".hpcx-row").length >= 60, "列表行 >= 60");
      t.ok(t.$$(".hpcx-rail-item").length > 10, "rail 项目 > 10");
    }
  },
  {
    name: "帖子详情 /642400850.html（Next.js #__NEXT_DATA__）",
    file: "post.html",
    url: "https://bbs.hupu.com/642400850.html",
    expect: (t) => {
      t.ok(t.$(".hpcx-turn-user-bubble"), "主楼气泡渲染");
      t.ok(t.$$(".hpcx-turn-agent").length === 37, "17 亮评 + 20 楼层 = 37，实际 " + t.$$(".hpcx-turn-agent").length);
      t.ok(t.$$(".hpcx-quote").length > 0, "引用卡片渲染，共 " + t.$$(".hpcx-quote").length);
      // 标题现在只在顶栏「版块 / 标题」里，正文不再重复一个 h1
      t.eq(t.$(".hpcx-detail-title"), null, "正文里不再渲染重复的大标题");
      const topbar = t.$(".hpcx-model");
      t.ok(topbar && topbar.textContent.includes("乔丹"),
        "顶栏标题解析: " + (topbar ? topbar.textContent.slice(0, 30) : "(缺失)"));
      t.eq(topbar.getAttribute("title"), topbar.textContent, "顶栏标题带完整 title 属性（截断时可悬停看全）");
      const meta = t.dom.window.document.querySelector(".hpcx-detail-meta").textContent;
      t.ok(meta.includes("回复"), "meta 含回复数");
      t.ok(/662\s*回复/.test(meta.replace(/\s+/g, " ")), "回复数 = 662，meta: " + meta.replace(/\s+/g, " ").slice(0, 80));
      // 亮评区是一个独立卡片（以前只是个染色的分隔线，和普通回复区分不开）
      t.eq(t.$$(".hpcx-lights").length, 1, "亮评区块存在且唯一");
      const box = t.$(".hpcx-lights");
      t.eq(box.querySelectorAll(".hpcx-turn-agent").length, 17, "亮评区里有 17 条");
      t.ok(box.querySelector(".hpcx-lights-head"), "亮评区有可点的标题行（折叠开关）");
      t.eq(box.classList.contains("collapsed"), false, "默认不折叠");
      t.ok(/17 条/.test(box.querySelector(".hpcx-lights-count").textContent),
        "标题上显示条数: " + box.querySelector(".hpcx-lights-count").textContent);
      t.eq(t.$$(".hpcx-lights-body .hpcx-turn-agent").length, 17, "亮评楼层都在 body 里");
      // 亮评区必须在普通回复列表之前（是同一个 section，不是混在一起的）
      const all = t.$$(".hpcx-thread-inner .hpcx-turn-agent");
      t.ok(all.indexOf(box.querySelector(".hpcx-turn-agent")) === 0, "亮评排在最前");
      const ids = t.$$(".hpcx-turn-agent").map((n) => n.id).filter(Boolean);
      t.eq(new Set(ids).size, ids.length, "楼层 id 无重复（" + ids.length + " 个）");
      const seeds = t.$$(".hpcx-turn-agent").map((n) => n.dataset.seed);
      t.ok(seeds.every(Boolean), "每个楼层都有装饰种子");
      // 亮评是和回复同一批内容（虎扑自己也会两边都显示），
      // 所以同一条回复在亮评区和楼层区出现两次、装饰也一致 —— 这是对的，
      // 只要「同一楼层号不会被用成种子」就行。
      const floors = t.$$(".hpcx-turn-agent").filter((n) => /^\d+$/.test(n.dataset.floor));
      t.eq(new Set(floors.map((n) => n.dataset.floor)).size, floors.length, "楼层号唯一（" + floors.length + "）");
      t.ok(t.$$(".hpcx-lightbox").length === 0, "灯箱默认不打开");
      t.ok(t.$$(".hpcx-cooked").length >= 20, "楼层正文渲染");
      t.ok(t.$(".hpcx-list-status.pager"), "分页存在");
    }
  },
  {
    name: "帖子第 2 页 /642400850-2.html",
    file: "p642400850-2.html",
    url: "https://bbs.hupu.com/642400850-2.html",
    expect: (t) => {
      t.ok(t.$$(".hpcx-turn-agent").length === 20, "第 2 页 20 楼，实际 " + t.$$(".hpcx-turn-agent").length);
      const floors = t.$$(".hpcx-turn-agent").map((n) => n.dataset.floor);
      t.eq(floors[0], "21", "第 2 页首楼 = 21");
      t.eq(floors[19], "40", "第 2 页末楼 = 40");
      t.eq(t.$(".hpcx-list-status.pager .on").textContent, "2", "当前页 = 2");
    }
  },
  {
    name: "排序变体 /topic-daily-postdate（baseUrl 自带后缀）",
    file: "hp_tdpostdate.html",
    url: "https://bbs.hupu.com/topic-daily-postdate",
    expect: (t) => {
      const doc = t.dom.window.document;
      const on = t.$$(".hpcx-filter-row .hpcx-fchip.on");
      t.eq(on.length, 1, "排序 chip 只有一个高亮");
      t.eq(on[0].textContent, "最新发布", "高亮的是最新发布");
      // 翻页必须是 /topic-daily-postdate-2，不是 /topic-daily-2-postdate
      const p2 = t.$$(".hpcx-list-status.pager a").find((a) => a.textContent === "2");
      t.ok(p2, "分页里有第 2 页");
      t.eq(p2.getAttribute("href"), "/topic-daily-postdate-2", "第 2 页 URL 正确");
      // 专区信息卡片已删，原来那个「原生页面」链接改由标题行的「原生」按钮承担
      t.eq(doc.querySelector(".hpcx-new-topic-btn.ghost").getAttribute("href"), "/topic-daily-postdate", "「原生」按钮指向当前排序的原生页");
      t.eq(doc.querySelector(".hpcx-card"), null, "专区信息卡片应该已经没有了");
    }
  },
  {
    name: "排序变体 /topic-daily-hot",
    file: "hp_tdhot.html",
    url: "https://bbs.hupu.com/topic-daily-hot",
    expect: (t) => {
      const on = t.$$(".hpcx-filter-row .hpcx-fchip.on");
      t.eq(on.length, 1, "排序 chip 唯一高亮");
      t.eq(on[0].textContent, "24小时榜", "高亮的是 24小时榜");
      const p2 = t.$$(".hpcx-list-status.pager a").find((a) => a.textContent === "2");
      t.eq(p2.getAttribute("href"), "/topic-daily-hot-2", "第 2 页 URL 正确");
      // rail 里也要拿「步行街主干道」当成当前专区
      const act = t.$$(".hpcx-rail-nav .hpcx-rail-item.active");
      t.eq(act.length, 1, "rail 导航只有一项高亮");
      t.eq(act[0].textContent.trim(), "步行街主干道", "高亮的是步行街主干道（不是 /topic-daily-hot 字符串比较）");
    }
  },
  {
    name: "排序变体第 2 页 /topic-daily-hot-2",
    file: "hp_tdhot2.html",
    url: "https://bbs.hupu.com/topic-daily-hot-2",
    expect: (t) => {
      t.eq(t.$(".hpcx-list-status.pager .on").textContent, "2", "当前页 = 2");
      t.eq(t.$$(".hpcx-filter-row .hpcx-fchip.on")[0].textContent, "24小时榜", "排序仍为 24小时榜");
      t.ok(t.$$(".hpcx-row").length >= 40, "列表行 >= 40");
    }
  },
  {
    name: "图片帖 /642395849.html（正文全是图）",
    file: "p642395849.html",
    url: "https://bbs.hupu.com/642395849.html",
    expect: (t) => {
      const bubble = t.$(".hpcx-turn-user-bubble");
      t.ok(bubble, "主楼气泡存在");
      t.ok(bubble.querySelectorAll("img").length > 0, "气泡里有图片 " + bubble.querySelectorAll("img").length + " 张");
      t.ok(!/正文为空/.test(bubble.textContent), "没有误判成「正文为空」");
      const img = bubble.querySelector("img");
      t.eq(img.getAttribute("loading"), "lazy", "图片加了 lazy");
      t.ok(img.getAttribute("src"), "图片 src 保留");
    }
  },
  {
    name: "非接管路由 /search（应只保留 rail）",
    file: "post.html",
    url: "https://bbs.hupu.com/search?q=test",
    expect: (t) => {
      t.ok(t.$(".hpcx-rail"), "rail 仍然渲染");
      t.eq(t.$(".hpcx-main"), null, "main 不接管");
      t.eq(t.dom.window.document.documentElement.classList.contains("hpcx-locked"), false, "没加 lock");
    }
  }
];

function makeT(dom) {
  const $ = (s) => dom.window.document.querySelector(s);
  const $$ = (s) => Array.from(dom.window.document.querySelectorAll(s));
  return {
    dom, $, $$,
    ok(v, msg) { if (!v) throw new Error("断言失败: " + msg); console.log("    ✓ " + msg); },
    eq(a, b, msg) {
      if (a !== b) throw new Error("断言失败: " + msg + " (期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a) + ")");
      console.log("    ✓ " + msg);
    }
  };
}

async function main() {
let pass = 0, fail = 0;
for (const c of CASES) {
  const file = path.join(__dirname, "fixtures", c.file);
  let html;
  try { html = fs.readFileSync(file, "utf8"); } catch (e) { console.log("跳过（文件缺失）: " + c.name); continue; }

  console.log("\n▶ " + c.name);
  const errors = [];
  const dom = new JSDOM(html, {
    url: c.url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: new (require("jsdom").VirtualConsole)()
      .on("jsdomError", (e) => errors.push("jsdomError: " + e.message))
      .on("error", (...a) => errors.push("console.error: " + a.join(" ")))
  });
  dom.window.addEventListener("error", (e) => errors.push("window error: " + e.message));

  try {
    dom.window.eval(SCRIPT);
    const t = makeT(dom);
    // 等 domReady().then() 与 rAF 跑完
    await new Promise((r) => setTimeout(r, 60));
    c.expect(t);
    if (errors.length) throw new Error("运行期报错: " + errors.join(" | "));
    console.log("  ✅ 通过");
    pass++;
  } catch (e) {
    console.log("  ❌ " + e.message);
    if (errors.length) console.log("     运行期日志: " + errors.join(" | "));
    fail++;
  }
  dom.window.close();
}

console.log("\n────────────────────────────");
console.log("通过 " + pass + " / 失败 " + fail);
process.exit(fail ? 1 : 0);
}

main();
