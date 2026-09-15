/**
 * 真实浏览器视觉验收：把保存下来的虎扑页面用本地 HTTP 服务起起来，
 * 注入 userscript，然后用本机 Chrome 截图。
 *
 * 只拦外站请求（站点自己的 JS/CSS/图片全部 abort），因为：
 *   1. 我们只验证「脚本自己画的 UI」，不验证站点前端；
 *   2. 数据是内联在 HTML 里的，不需要外站资源；
 *   3. 不依赖网络，跑得快且稳定。
 *
 * 用法: node shots.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const { chromium } = require("playwright-core");

const FIXTURES = path.join(__dirname, "fixtures");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, ".test", "shots");

const PAGES = {
  "/topic-daily": "topic-daily.html",
  "/topic-daily-postdate": "hp_tdpostdate.html",
  "/all-gambia": "hp_all-gambia.html",
  "/": "hp_home.html",
  "/642400850.html": "post.html",
  "/642400850-2.html": "p642400850-2.html",
  "/642395849.html": "p642395849.html",
  "/search": "post.html"
};

/**
 * 额外路由：把 fixture 改成「已登录」的样子，用来拍登录态对照图。
 * 替换点与 login.js 保持一致（必须是精确字符串，改错了直接抛）。
 */
const OVERRIDES = {
  "/login-topic-daily": {
    file: "topic-daily.html",
    patches: [['{"topic":{"isLogin":false', '{"topic":{"isLogin":true']]
  },
  "/login-post": {
    file: "post.html",
    patches: [['"euid":""', '"euid":"190905797171683"']]
  }
};

function patched(file, patches) {
  let html = fs.readFileSync(path.join(FIXTURES, file), "utf8");
  for (const [from, to] of patches) {
    const n = html.split(from).length - 1;
    if (n !== 1) throw new Error(`${file}: "${from}" 期望 1 次，实际 ${n} 次`);
    html = html.replace(from, to);
  }
  return html;
}

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
].find((p) => fs.existsSync(p));

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      // 截图时把写接口打桩成成功，免得拍到的是「点亮失败：HTTP 404」
      if (url.pathname.indexOf("/pcmapi/") === 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 200, data: null }));
        return;
      }
      // ?login=1 → 已登录的详情页。必须挂在 /642400850.html 这个路径上，
      // 因为脚本只按 pathname 判路由（换个路径名就不接管主区了）。
      if (url.pathname === "/642400850.html" && url.searchParams.get("login") === "1") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(patched("post.html", OVERRIDES["/login-post"].patches));
        return;
      }
      const html = (pathname) => {
        const ov = OVERRIDES[pathname];
        if (ov) return patched(ov.file, ov.patches);
        const f = PAGES[pathname];
        return f ? fs.readFileSync(path.join(FIXTURES, f)) : null;
      };
      const body = html(url.pathname);
      if (!body) { res.writeHead(404); res.end("nope"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { srv, port } = await serve();
  const SCRIPT = fs.readFileSync(path.join(ROOT, "hupu-codex.user.js"), "utf8");

  const browser = await chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
    locale: "zh-CN"
  });

  // 只在 http://localhost 上放行，其余全部 abort
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) return route.continue();
    return route.abort();
  });

  await ctx.addInitScript({ content: SCRIPT });

  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) logs.push(m.text()); });
  page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

  async function shot(name, url, prep) {
    await page.goto(`http://127.0.0.1:${port}${url}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    if (prep) await prep(page);
    await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: false });
    console.log("  📸 " + name + ".png");
  }

  console.log("生成截图中…");
  await shot("01-list-dark", "/topic-daily");
  await shot("02-list-light", "/topic-daily", (p) =>
    p.evaluate(() => {
      localStorage.setItem("hpcx:settings", JSON.stringify({ theme: "light" }));
    }).then(() => p.reload({ waitUntil: "domcontentloaded" })).then(() => p.waitForTimeout(400))
  );
  await shot("03-thread-dark", "/642400850.html");
  await shot("04-thread-scrolled", "/642400850.html", async (p) => {
    await p.evaluate(() => { document.querySelector(".hpcx-thread").scrollTop = 900; });
    await p.waitForTimeout(150);
  });
  await shot("05-thread-image", "/642395849.html");
  await shot("06-category", "/all-gambia");
  await shot("07-home-light", "/", (p) =>
    p.evaluate(() => {
      localStorage.setItem("hpcx:settings", JSON.stringify({ theme: "light" }));
    }).then(() => p.reload({ waitUntil: "domcontentloaded" })).then(() => p.waitForTimeout(400))
  );
  await shot("08-boss", "/642400850.html", async (p) => {
    await p.keyboard.press("Escape");
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
  });
  await shot("09-settings", "/topic-daily", async (p) => {
    await p.evaluate(() => {
      localStorage.setItem("hpcx:settings", JSON.stringify({}));
    });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(350);
    await p.keyboard.press("Control+,");
    await p.waitForTimeout(200);
  });
  await shot("10-narrow", "/topic-daily", async (p) => {
    await p.setViewportSize({ width: 760, height: 900 });
    await p.waitForTimeout(250);
  });

  // diff 模式 + 浅色，一个额外的组合
  await shot("11-diff-light", "/642400850.html", async (p) => {
    await p.setViewportSize({ width: 1600, height: 1000 });
    await p.waitForTimeout(350);
    await p.evaluate(() => {
      localStorage.setItem("hpcx:settings", JSON.stringify({ theme: "light", codeMode: "diff", lang: "go" }));
    });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400);
    await p.setViewportSize({ width: 1600, height: 1000 });
  });

  // 登录态对照：同一页面，只有「已登录 / 未登录」的差别
  await shot("12-login-topic", "/login-topic-daily", async (p) => {
    await p.evaluate(() => { localStorage.removeItem("hpcx:settings"); });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400);
  });
  await shot("13-login-post", "/login-post", async (p) => {
    await p.evaluate(() => { localStorage.removeItem("hpcx:settings"); });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400);
  });

  // 悬停预览的位置：图在中间，预览应该贴在图旁边（而不是右下角）
  await shot("14-hover-preview", "/642395849.html", async (p) => {
    await p.evaluate(() => { localStorage.removeItem("hpcx:settings"); });
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(400);
    await p.evaluate(() => {
      const host = document.querySelector(".hpcx-cooked") || document.querySelector(".hpcx-turn-user-bubble");
      host.innerHTML = "";
      const mk = (w, h, c) => "data:image/svg+xml," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="${c}"/></svg>`);
      const img = document.createElement("img");
      img.src = mk(300, 200, "#3a7");
      img.dataset.origin = mk(900, 620, "#2b6");
      host.appendChild(img);
    });
    await p.waitForTimeout(200);
    await p.hover(".hpcx-cooked img");
    await p.waitForTimeout(400);
  });

  // 亮评区：折叠 / 展开 / 换底色 三种状态
  const lightsShot = async (name, settings, prep) => {
    await shot(name, "/642400850.html", async (p) => {
      await p.evaluate((st) => localStorage.setItem("hpcx:settings", JSON.stringify(st)), settings);
      await p.reload({ waitUntil: "domcontentloaded" });
      await p.waitForTimeout(500);
      if (prep) await prep(p);
    });
  };
  await lightsShot("15-lights-default", {});
  await lightsShot("16-lights-collapsed", { lightsCollapsed: true });
  await lightsShot("17-lights-blue", { lightsBg: "#4f8cff", lightsTint: 26 });

  // 设置面板里的亮评那一节（确认取色器 + 浓度滑块排得下）
  await shot("18-settings-lights", "/642400850.html", async (p) => {
    await p.evaluate(() => localStorage.removeItem("hpcx:settings"));
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(450);
    await p.keyboard.press("Control+,");
    await p.waitForTimeout(250);
    await p.evaluate(() => {
      const row = document.querySelector('[data-row="lightsBg"]');
      if (row) row.scrollIntoView({ block: "center" });
    });
    await p.waitForTimeout(250);
  });

  // 回帖输入框：已登录（有「回复」按钮 + 引用条）
  await shot("19-composer-login", "/642400850.html?login=1", async (p) => {
    await p.evaluate(() => localStorage.removeItem("hpcx:settings"));
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(500);
    await p.evaluate(() => {
      document.querySelector(".hpcx-editor").textContent =
        "这轮系列赛的防守强度确实不一样，看下第三场的调整。";
      document.querySelector(".hpcx-editor").dispatchEvent(new Event("input", { bubbles: true }));
    });
    await p.hover(".hpcx-turn-agent");
    await p.click('.hpcx-act[data-act="reply"][data-floor="1"]');
    await p.waitForTimeout(250);
  });

  // 发新帖弹框（版块列表页 + 已登录）
  await shot("20-publish", "/login-topic-daily", async (p) => {
    await p.evaluate(() => localStorage.removeItem("hpcx:settings"));
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(500);
    await p.click("[data-publish]");
    await p.waitForTimeout(250);
    await p.evaluate(() => {
      document.querySelector("[data-pub-title]").value = "关于昨晚那场加时赛，说几个细节";
      document.querySelector("[data-pub-content]").value =
        "第四节最后两分钟那个回合，**换防之后的错位**其实已经很明显了。\n\n> 当时解说还在说体能问题\n\n我倾向于认为是战术选择，不是跑不动。";
    });
    await p.waitForTimeout(150);
  });

  // 点亮后的楼层操作条
  await shot("21-lighted", "/642400850.html?login=1", async (p) => {
    await p.evaluate(() => localStorage.removeItem("hpcx:settings"));
    await p.reload({ waitUntil: "domcontentloaded" });
    await p.waitForTimeout(600);
    // 直接点第一个普通楼层的「亮」，看状态与计数变化
    // 直接派发点击，避开「操作条 hover 才显形 / 坐标命中」这些干扰
    await p.evaluate(() => {
      const btn = [...document.querySelectorAll('.hpcx-act[data-act="light"]')]
        .find((b) => b.dataset.pid);
      if (btn) {
        btn.closest(".hpcx-turn").classList.add("hpcx-turn-pin");
        btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      }
    });
    await p.waitForTimeout(400);
  });

  if (logs.length) console.log("\n⚠️ 控制台报错:\n  " + logs.join("\n  "));
  else console.log("\n✅ 全程无控制台报错");

  await browser.close();
  srv.close();
  console.log("截图目录: " + OUT);
})();
