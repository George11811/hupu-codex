/**
 * 交互测试：在 jsdom 里真的去点、去按键盘，验证摸鱼相关的核心行为。
 * 用法: node interact.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const SCRIPT = fs.readFileSync(process.env.SCRIPT || path.join(__dirname, "..", "hupu-codex.user.js"), "utf8");
const FIXTURES = path.join(__dirname, "fixtures");
const ROOT = path.join(__dirname, "..");

/** 亮评区底色的默认值，和脚本里的 DEFAULTS 保持一致 */
const DEFAULTS_LIGHTS_BG = "#f0d1c6";   // 和脚本 DEFAULTS.lightsBg 保持一致

let pass = 0, fail = 0;
const failures = [];

function check(name, fn) {
  try { fn(); console.log("    ✓ " + name); pass++; }
  catch (e) { console.log("    ✗ " + name + " → " + e.message); failures.push(name); fail++; }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(msg + " (期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a) + ")");
}
function ok(v, msg) { if (!v) throw new Error(msg); }

async function boot(file, url, settings, opts) {
  const o = opts || {};
  const errors = [];
  const vc = new VirtualConsole();
  // jsdom 没实现页面跳转（“Not implemented: navigation”），而 rail 里到处是 <a>。
  // 真实浏览器里的跳转行为由 browser.js 负责验证，这里只关心脚本自己的报错。
  const ignorable = (m) => /Not implemented: navigation/.test(m);
  vc.on("jsdomError", (e) => { if (!ignorable(e.message)) errors.push("jsdomError: " + e.message); });
  vc.on("error", (...a) => {
    const m = a.join(" ");
    if (!ignorable(m)) errors.push("console.error: " + m);
  });
  const dom = new JSDOM(o.htmlOverride != null ? o.htmlOverride : fs.readFileSync(path.join(FIXTURES, file), "utf8"), {
    url, runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc
  });
  const w = dom.window;
  // 站点脚本会用到的、jsdom 没有的东西
  w.prompt = () => "乔丹";
  w.open = (u) => { w.__opened = u; };
  // fetch 打桩：jsdom 自己没实现 fetch，我们记下调用并返回预设结果
  w.__fetchCalls = [];
  if (o.fetchStub !== undefined && o.fetchStub !== null && o.fetchStub !== false) {
    w.fetch = (u, opt) => {
      w.__fetchCalls.push({ url: u, opts: opt || {} });
      if (o.fetchStub.reject) return Promise.reject(new Error(o.fetchStub.reject));
      return Promise.resolve({
        ok: o.fetchStub.ok !== false,
        status: o.fetchStub.status || 200,
        json: () => Promise.resolve(o.fetchStub.body || {})
      });
    };
  }
  // 设置要在脚本跑之前就写进去（脚本会读 localStorage 初始化）
  if (settings) w.localStorage.setItem("hpcx:settings", JSON.stringify(settings));
  w.eval(SCRIPT);
  await new Promise((r) => setTimeout(r, 60));
  return { dom, w, doc: w.document, errors };
}

function key(w, init) {
  // 真实按键的 target 是 body（或焦点元素），事件会 → document → window 传播。
  // 直接派发到 window 会跳过 document 上的监听器，和浏览器行为不一致。
  const target = (w.document && w.document.body) || w;
  const e = new w.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init));
  target.dispatchEvent(e);
  return e;
}
function click(w, node) {
  if (!node) throw new Error("要点击的元素不存在");
  node.dispatchEvent(new w.MouseEvent("click", { bubbles: true, cancelable: true }));
}

/** 打开/关闭设置面板（测试里用来制造额外 render） */
function openSettings4Test(w, doc) {
  const btn = doc.querySelector("[data-settings-open]");
  if (btn) click(w, btn);
  return doc.querySelector(".hpcx-modal");
}
function closeSettings4Test(w, doc) {
  const m = doc.querySelector(".hpcx-modal");
  if (m) m.hidden = true;
}

(async function main() {
  /* ---------- 1. 应急伪装 ---------- */
  console.log("\n▶ 应急伪装（连按两下 Esc / Ctrl+Shift+H）");
  {
    const { w, doc, errors } = await boot("post.html", "https://bbs.hupu.com/642400850.html");
    const root = doc.documentElement;

    check("初始未开启", () => eq(root.classList.contains("hpcx-boss-on"), false, "boss-on 不存在"));

    key(w, { key: "Escape" });
    key(w, { key: "Escape" });
    check("两下 Esc 开启伪装视图", () => {
      eq(root.classList.contains("hpcx-boss-on"), true, "boss-on 已加");
      const box = doc.querySelector(".hpcx-boss");
      ok(box && box.hidden === false, "boss 容器可见");
      ok(box.querySelectorAll(".hpcx-code-line").length >= 70, "伪装视图有代码行");
      ok(/cargo test/.test(box.querySelector("[data-boss-log]").textContent), "终端里有构建日志");
      ok(/^~\//.test(box.querySelector("[data-boss-shell]").textContent), "shell 路径已填");
    });

    key(w, { key: "Escape" });
    key(w, { key: "Escape" });
    check("再两下 Esc 恢复", () => eq(root.classList.contains("hpcx-boss-on"), false, "boss-on 已移除"));

    key(w, { key: "h", ctrlKey: true, shiftKey: true });
    check("Ctrl+Shift+H 始终有效", () => eq(root.classList.contains("hpcx-boss-on"), true, "已开启"));
    key(w, { key: "h", ctrlKey: true, shiftKey: true });
    check("Ctrl+Shift+H 再按关闭", () => eq(root.classList.contains("hpcx-boss-on"), false, "已关闭"));

    check("全流程无报错", () => eq(errors.length, 0, errors.join(" | ")));
    w.close();
  }

  /* ---------- 2. 设置面板 ---------- */
  console.log("\n▶ 设置面板");
  {
    const { w, doc, errors } = await boot("topic-daily.html", "https://bbs.hupu.com/topic-daily");

    key(w, { key: ",", ctrlKey: true });
    const modal = doc.querySelector(".hpcx-modal");
    check("Ctrl+, 打开设置面板", () => {
      ok(modal && modal.hidden === false, "面板可见");
      ok(modal.querySelectorAll(".hpcx-set-row").length >= 15, "设置项 >= 15，实际 " + modal.querySelectorAll(".hpcx-set-row").length);
    });

    const rows = modal.querySelectorAll("[data-set-toggle]").length;
    check("开关控件都在", () => ok(rows >= 6, "toggle 数量 = " + rows));

    // 关掉「显示右侧代码面板」
    const panelToggle = modal.querySelector('[data-set-toggle="codePanel"]');
    click(w, panelToggle);
    check("切换 codePanel -> 写入 localStorage 并立即生效", () => {
      const saved = JSON.parse(w.localStorage.getItem("hpcx:settings"));
      eq(saved.codePanel, false, "localStorage 已更新");
      ok(doc.querySelector(".hpcx-main").classList.contains("panel-hidden"), "面板已隐藏");
      eq(panelToggle.classList.contains("on"), false, "开关状态同步");
    });

    // 切主题
    const themeSel = modal.querySelector('[data-set-select="theme"]');
    themeSel.value = "light";
    themeSel.dispatchEvent(new w.Event("change", { bubbles: true }));
    check("切浅色主题", () => {
      eq(doc.documentElement.classList.contains("hpcx-light"), true, "hpcx-light 类已加");
      eq(JSON.parse(w.localStorage.getItem("hpcx:settings")).theme, "light", "已落盘");
    });

    // 换语言 → 代码面板 + 标题都跟着变
    const langSel = modal.querySelector('[data-set-select="lang"]');
    langSel.value = "python";
    langSel.dispatchEvent(new w.Event("change", { bubbles: true }));
    check("换语言 → 文件名 / 标题 / 面板同步", () => {
      eq(doc.querySelector("[data-code-file-name]").textContent, "crawler.py", "面板文件名");
      eq(doc.title, "crawler.py — platform", "标签页标题: " + doc.title);
      eq(doc.querySelector("[data-code-crumb-file]").textContent, "crawler.py", "面包屑文件名");
    });

    // 逐个语言检查：假代码不许有重复 block（早前版本的 bug）
    for (const lang of ["rust", "python", "typescript", "go", "java"]) {
      langSel.value = lang;
      langSel.dispatchEvent(new w.Event("change", { bubbles: true }));
      check("语言 " + lang + " 生成的代码无重复 block", () => {
        const body = doc.querySelector("[data-code-body]");
        const text = body.textContent;
        const n = body.querySelectorAll(".hpcx-code-line").length;
        ok(n >= 55, "行数 " + n);
        // 取每行首尾，统计重复的行签名
        const lines = Array.from(body.querySelectorAll(".hpcx-src")).map((s) => s.textContent);
        const sig = lines.filter((l) => /^\s*(pub (struct|enum|fn)|def |class |func |public |interface |const |#[a-z])/.test(l));
        const dupes = sig.filter((l, i) => sig.indexOf(l) !== i);
        eq(dupes.length, 0, "重复的声明行: " + JSON.stringify(dupes.slice(0, 3)));
      });
    }
    langSel.value = "rust";
    langSel.dispatchEvent(new w.Event("change", { bubbles: true }));

    // Esc 关面板（而不是触发伪装）
    key(w, { key: "Escape" });
    check("Esc 关面板且不触发伪装", () => {
      eq(modal.hidden, true, "面板已关");
      eq(doc.documentElement.classList.contains("hpcx-boss-on"), false, "没误触发伪装");
    });

    // 恢复默认
    key(w, { key: ",", ctrlKey: true });
    click(w, modal.querySelector("[data-settings-reset]"));
    check("恢复默认", () => {
      eq(JSON.parse(w.localStorage.getItem("hpcx:settings")).lang, "rust", "语言回 rust");
      eq(doc.title, "topic_cache.rs — platform", "标题回 rust 文件名");
    });

    // 刷新后设置要还在
    const saved = JSON.stringify({ theme: "light", railWidth: 260, lang: "go" });
    check("设置可持久化（预置 → 重新加载生效）", async () => {});
    w.close();

    const second = await boot("topic-daily.html", "https://bbs.hupu.com/topic-daily");
    second.w.localStorage.setItem("hpcx:settings", saved);
    // 重新跑一次脚本（模拟刷新）
    second.w.eval(SCRIPT);
    await new Promise((r) => setTimeout(r, 60));
    check("重新加载后读到已保存的设置", () => {
      // 第二次 eval 会因为已有 DOM 而复用，但设置必须生效
      const s2 = JSON.parse(second.w.localStorage.getItem("hpcx:settings"));
      eq(s2.lang, "go", "语言仍为 go");
      eq(second.doc.documentElement.classList.contains("hpcx-light"), true, "浅色仍生效");
    });
    eq(errors.length, 0, "全流程无报错: " + errors.join(" | "));
    second.w.close();
  }

  /* ---------- 3. 草稿板 ---------- */
  console.log("\n▶ 草稿板");
  {
    const { w, doc, errors } = await boot("post.html", "https://bbs.hupu.com/642400850.html");
    const editor = doc.querySelector(".hpcx-editor");

    check("草稿板存在且是 contenteditable", () => {
      ok(editor, "editor 存在");
      eq(editor.getAttribute("contenteditable"), "true", "contenteditable");
      ok(doc.querySelector(".hpcx-composer-target").textContent.includes("Re："), "显示回复目标");
    });

    editor.textContent = "我觉得这个说法有问题";
    editor.dispatchEvent(new w.Event("input", { bubbles: true }));
    check("输入 → 存进 localStorage（按 tid 分键）", () => {
      eq(w.localStorage.getItem("hpcx:draft:642400850"), "我觉得这个说法有问题", "草稿已存");
      ok(/10 字/.test(doc.querySelector("[data-composer-status]").textContent),
        "字数统计: " + doc.querySelector("[data-composer-status]").textContent);
    });

    check("换帖子用不同的草稿键", () => {
      eq(w.localStorage.getItem("hpcx:draft:999"), null, "别的帖子没有草稿");
    });

    // 点某楼的「回复」→ 引用 + @ 写进草稿（第 1 页是 1-20 楼）
    const act = doc.querySelector('.hpcx-act[data-act="reply"][data-floor="7"]');
    check("第 7 楼有回复按钮", () => ok(act, "按钮存在"));
    click(w, act);
    check("点「回复」→ 引用原文 + @用户 写进草稿", () => {
      const text = doc.querySelector(".hpcx-editor").textContent;
      ok(/^> /.test(text), "以引用开头: " + JSON.stringify(text.slice(0, 60)));
      ok(/@\S+ /.test(text), "含 @用户名");
      ok(text.indexOf("我觉得这个说法有问题") > 0, "原有草稿保留在后面");
      ok(/已写入草稿/.test(doc.querySelector(".hpcx-toast").textContent), "给出了提示");
    });

    // markdown 工具栏
    const edit2 = doc.querySelector(".hpcx-editor");
    edit2.textContent = "abc";
    edit2.dispatchEvent(new w.Event("input", { bubbles: true }));
    // 全选后再点加粗
    const range = doc.createRange();
    range.selectNodeContents(edit2);
    const sel = w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    click(w, doc.querySelector('[data-md="bold"]'));
    check("工具栏「加粗」对选中文本生效", () => {
      eq(doc.querySelector(".hpcx-editor").textContent, "**abc**", "已包 **");
    });

    click(w, doc.querySelector('[data-md="preview"]'));
    check("markdown 预览能渲染", () => {
      const p = doc.querySelector("[data-composer-preview]");
      eq(p.hidden, false, "预览已展开");
      ok(/<strong>abc<\/strong>/.test(p.innerHTML), "加粗渲染出来了: " + p.innerHTML);
    });

    click(w, doc.querySelector('[data-md="clear"]'));
    check("清空草稿", () => {
      eq(doc.querySelector(".hpcx-editor").textContent, "", "编辑区已空");
      eq(w.localStorage.getItem("hpcx:draft:642400850"), null, "localStorage 已清");
    });

    check("全流程无报错", () => eq(errors.length, 0, errors.join(" | ")));
    w.close();
  }

  /* ---------- 4. 引用卡片 / 思考块折叠 / 灯箱 ---------- */
  /* ---------- 5.4 亮评区：折叠 + 底色 ---------- */
  console.log("\n▶ 亮评区（折叠 / 底色）");
  {
    const { w, doc, errors } = await boot("post.html", "https://bbs.hupu.com/642400850.html");
    const lights = doc.querySelector(".hpcx-lights");

    check("亮评区默认展开、可点标题折叠", () => {
      ok(lights, "区块存在");
      eq(lights.classList.contains("collapsed"), false, "初始展开");
      click(w, lights.querySelector("[data-lights-toggle]"));
      eq(lights.classList.contains("collapsed"), true, "点一下折叠");
      click(w, lights.querySelector("[data-lights-toggle]"));
      eq(lights.classList.contains("collapsed"), false, "再点展开");
    });

    check("折叠状态只影响这一块，不碰普通回复", () => {
      click(w, lights.querySelector("[data-lights-toggle]"));
      const turnsOutside = [...doc.querySelectorAll(".hpcx-turn-agent")]
        .filter((n) => !n.closest(".hpcx-lights"));
      eq(turnsOutside.length, 20, "普通楼层仍有 20 条");
      eq(lights.classList.contains("collapsed"), true, "亮评区已折叠");
      click(w, lights.querySelector("[data-lights-toggle]"));
    });

    check("底色：默认会给亮评区刷上混色变量", () => {
      const root = doc.documentElement;
      const bg = root.style.getPropertyValue("--hpcx-lights-bg").trim();
      const tint = root.style.getPropertyValue("--hpcx-lights-tint").trim();
      const edge = root.style.getPropertyValue("--hpcx-lights-edge").trim();
      eq(bg, DEFAULTS_LIGHTS_BG, "底色变量 = 默认色");
      ok(/^\d+%$/.test(tint) && parseFloat(tint) > 0, "浓度 > 0: " + tint);
      ok(parseFloat(edge) > parseFloat(tint), "边框浓度更高: " + edge);
    });

    check("改底色 → 立即生效并落盘", () => {
      openSettings4Test(w, doc);
      const input = doc.querySelector('[data-set-color="lightsBg"]');
      ok(input, "设置面板里有取色器");
      input.value = "#3366ff";
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
      eq(doc.documentElement.style.getPropertyValue("--hpcx-lights-bg").trim(), "#3366ff", "即时预览");
      input.dispatchEvent(new w.Event("change", { bubbles: true }));
      eq(JSON.parse(w.localStorage.getItem("hpcx:settings")).lightsBg, "#3366ff", "已落盘");
    });

    check("点「无」→ 浓度为 0（不加底色）", () => {
      const off = doc.querySelector('[data-color-off="lightsBg"]');
      ok(off, "有「无」按钮");
      click(w, off);
      eq(JSON.parse(w.localStorage.getItem("hpcx:settings")).lightsBg, "", "已清空");
      eq(doc.documentElement.style.getPropertyValue("--hpcx-lights-tint").trim(), "0%", "浓度归零");
      eq(doc.documentElement.style.getPropertyValue("--hpcx-lights-bg").trim(), "transparent", "底色变透明");
    });

    check("拖浓度滑块即时生效", () => {
      // 先把颜色选回来 —— 上一条点了「无」，底色为空时浓度会被强制成 0（这是对的）
      const color = doc.querySelector('[data-set-color="lightsBg"]');
      color.value = "#f0d1c6";
      color.dispatchEvent(new w.Event("input", { bubbles: true }));
      const r = doc.querySelector('[data-set-range="lightsTint"]');
      ok(r, "有浓度滑块");
      r.value = "40";
      r.dispatchEvent(new w.Event("input", { bubbles: true }));
      eq(doc.documentElement.style.getPropertyValue("--hpcx-lights-tint").trim(), "40%", "即时预览");
      r.dispatchEvent(new w.Event("change", { bubbles: true }));
      eq(JSON.parse(w.localStorage.getItem("hpcx:settings")).lightsTint, 40, "已落盘");
    });

    closeSettings4Test(w, doc);
    check("全流程无报错", () => eq(errors.length, 0, errors.join(" | ")));
    w.close();

    // 默认折叠 + 关掉亮评区
    const c = await boot("post.html", "https://bbs.hupu.com/642400850.html",
      { lightsCollapsed: true });
    check("配 lightsCollapsed=true → 一打开就是折叠的", () => {
      eq(c.doc.querySelector(".hpcx-lights").classList.contains("collapsed"), true, "已折叠");
      eq(c.doc.querySelectorAll(".hpcx-lights-body .hpcx-turn-agent").length, 17,
        "楼层还在 DOM 里（只是不显示）");
    });
    c.w.close();

    const d = await boot("post.html", "https://bbs.hupu.com/642400850.html", { showLights: false });
    check("关掉「单独分出亮评区」→ 不渲染这一块", () => {
      eq(d.doc.querySelector(".hpcx-lights"), null, "没有亮评区");
      eq(d.doc.querySelectorAll(".hpcx-turn-agent").length, 20, "只剩 20 条普通楼层");
    });
    d.w.close();
  }

  /* ---------- 5.6 回帖功能 ---------- */
  console.log("\n▶ 回帖（发表 / 楼中楼 / 失败处理）");
  {
    // 登录态：复用 login.js 那套「把 fixture 改成已登录」的手法
    const loggedIn = (file, patches) => {
      let h = fs.readFileSync(path.join(FIXTURES, file), "utf8");
      for (const [a, b] of patches) {
        const n = h.split(a).length - 1;
        if (n !== 1) throw new Error(`${file}: "${a}" 期望 1 次，实际 ${n} 次`);
        h = h.replace(a, b);
      }
      return h;
    };
    const NEXT_LOGIN = [['"euid":""', '"euid":"190905797171683"']];

    /** 带登录态 + fetch 打桩地启动 */
    const bootReply = async (opts) => {
      const o = opts || {};
      const html = o.loggedIn ? loggedIn("post.html", NEXT_LOGIN) : null;
      const r = await boot("post.html", "https://bbs.hupu.com/642400850.html", null, {
        htmlOverride: html,
        fetchStub: o.fetchStub !== undefined ? o.fetchStub : { ok: true, body: { code: 200 } }
      });
      return r;
    };

    /* —— 已登录：按钮与提示 —— */
    const a = await bootReply({ loggedIn: true });
    check("已登录 → 有「回复」按钮，提示 Ctrl+Enter 发表", () => {
      ok(a.doc.querySelector('.hpcx-send[data-md="reply"]'), "回复按钮存在");
      ok(/Ctrl\+Enter 发表/.test(a.doc.querySelector(".hpcx-composer-hint").textContent),
        a.doc.querySelector(".hpcx-composer-hint").textContent);
      eq(a.doc.querySelector('.hpcx-send[data-md="copy"]').textContent.trim(), "复制",
        "复制按钮降级为次要按钮");
    });

    /* —— 未登录：不给发表按钮 —— */
    const b2 = await bootReply({ loggedIn: false });
    check("未登录 → 不给发表按钮，改成引导登录", () => {
      eq(b2.doc.querySelector('.hpcx-send[data-md="reply"]'), null, "不该有回复按钮");
      const login = b2.doc.querySelector(".hpcx-composer-bar a[href*='passport']");
      ok(login, "有登录链接");
      ok(/未登录/.test(b2.doc.querySelector(".hpcx-composer-hint").textContent), "提示未登录");
    });
    b2.w.close();

    /* —— 空内容不发请求 —— */
    a.w.__fetchCalls.length = 0;
    click(a.w, a.doc.querySelector('.hpcx-send[data-md="reply"]'));
    await new Promise((r) => setTimeout(r, 30));
    check("草稿为空时不发请求", () => {
      eq(a.w.__fetchCalls.length, 0, "fetch 调用次数");
      ok(/内容为空/.test(a.doc.querySelector(".hpcx-toast").textContent), "提示内容为空");
    });

    /* —— 正常发表 —— */
    a.w.__fetchCalls.length = 0;
    a.doc.querySelector(".hpcx-editor").textContent = "**测试**回复";
    a.doc.querySelector(".hpcx-editor").dispatchEvent(new a.w.Event("input", { bubbles: true }));
    click(a.w, a.doc.querySelector('.hpcx-send[data-md="reply"]'));
    await new Promise((r) => setTimeout(r, 50));
    const call = a.w.__fetchCalls[0];
    check("POST 到 /pcmapi/pc/bbs/v1/createReply，带 cookie", () => {
      ok(call, "发起了请求");
      eq(call.url, "/pcmapi/pc/bbs/v1/createReply", "接口路径");
      eq(call.opts.method, "POST", "方法");
      eq(call.opts.credentials, "include", "要带 cookie");
      eq(call.opts.headers["Content-Type"], "application/json", "Content-Type");
    });
    check("body 字段与站内一致（tid/fid/topicId/content）", () => {
      const body = JSON.parse(call.opts.body);
      eq(body.tid, "642400850", "tid");
      eq(body.fid, "34", "fid");
      eq(body.topicId, "1", "topicId");
      ok(/<strong>测试<\/strong>回复/.test(body.content), "markdown 已转成 HTML: " + body.content);
      ok(!("pid" in body), "顶层回复不带 pid");
    });
    check("成功后清空草稿 + 提示", () => {
      eq(a.doc.querySelector(".hpcx-editor").textContent, "", "草稿已清空");
      ok(/回复成功/.test(a.doc.querySelector(".hpcx-toast").textContent),
        a.doc.querySelector(".hpcx-toast").textContent);
      eq(a.w.localStorage.getItem("hpcx:draft:642400850"), null, "本地草稿也清了");
    });
    a.w.close();

    /* —— 楼中楼：点某楼的「回复」 —— */
    const c = await bootReply({ loggedIn: true });
    const replyBtn = c.doc.querySelector('.hpcx-act[data-act="reply"][data-floor="7"]');
    check("点「回复」→ 顶部变成「回复 @xxx（N 楼）」引用条", () => {
      ok(replyBtn, "有回复按钮");
      ok(replyBtn.dataset.pid, "按钮带 pid（否则做成楼中楼）: " + replyBtn.dataset.pid);
      click(c.w, replyBtn);
      const t = c.doc.querySelector(".hpcx-composer-target");
      ok(t.classList.contains("quoting"), "切到引用态: " + t.textContent);
      ok(/回复 /.test(t.textContent) && /7 楼/.test(t.textContent), t.textContent);
      ok(t.querySelector('[data-md="cancel-quote"]'), "有取消按钮");
    });
    check("楼中楼的正文只留 @，引用交给接口（不再塞 > 原文）", () => {
      const text = c.doc.querySelector(".hpcx-editor").textContent;
      ok(/^@/.test(text), "以 @ 开头: " + JSON.stringify(text));
      ok(!/^>/.test(text), "不该出现 > 引用块");
    });
    c.w.__fetchCalls.length = 0;
    c.doc.querySelector(".hpcx-editor").textContent = "@某人 同意";
    click(c.w, c.doc.querySelector('.hpcx-send[data-md="reply"]'));
    await new Promise((r) => setTimeout(r, 50));
    check("楼中楼请求带 pid + data.atc_content", () => {
      const body = JSON.parse(c.w.__fetchCalls[0].opts.body);
      eq(body.pid, replyBtn.dataset.pid, "pid");
      ok(body.data && body.data.atc_content, "atc_content 不能为空");
      ok(/\S/.test(body.data.atc_content), "atc_content 有内容");
    });
    check("发表成功后引用条也清掉", () => {
      const t = c.doc.querySelector(".hpcx-composer-target");
      eq(t.classList.contains("quoting"), false, "回到普通标题态");
    });

    check("点 ✕ 取消引用", () => {
      click(c.w, c.doc.querySelector('.hpcx-act[data-act="reply"][data-floor="8"]'));
      ok(c.doc.querySelector(".hpcx-composer-target").classList.contains("quoting"), "先进入引用态");
      click(c.w, c.doc.querySelector('[data-md="cancel-quote"]'));
      eq(c.doc.querySelector(".hpcx-composer-target").classList.contains("quoting"), false,
        "取消后回到普通态");
    });
    c.w.close();

    /* —— 未登录点「回复」→ 保持旧行为（把引用写进草稿） —— */
    const d = await bootReply({ loggedIn: false });
    check("未登录点「回复」→ 仍把引用原文写进草稿（方便手动贴）", () => {
      click(d.w, d.doc.querySelector('.hpcx-act[data-act="reply"][data-floor="7"]'));
      const text = d.doc.querySelector(".hpcx-editor").textContent;
      ok(/^> /.test(text), "以引用开头: " + JSON.stringify(text.slice(0, 50)));
      ok(/@\S+ /.test(text), "带 @用户名");
      eq(d.doc.querySelector(".hpcx-composer-target").classList.contains("quoting"), false,
        "未登录不做楼中楼，不显示引用条");
    });
    d.w.close();

    /* —— 服务端拒绝 —— */
    const e2 = await bootReply({
      loggedIn: true,
      fetchStub: { ok: true, body: { code: 400, message: "内容包含敏感词" } }
    });
    e2.doc.querySelector(".hpcx-editor").textContent = "随便写点";
    click(e2.w, e2.doc.querySelector('.hpcx-send[data-md="reply"]'));
    await new Promise((r) => setTimeout(r, 50));
    check("服务端报错时把 message 透出来，草稿保留", () => {
      ok(/敏感词/.test(e2.doc.querySelector(".hpcx-toast").textContent),
        e2.doc.querySelector(".hpcx-toast").textContent);
      eq(e2.doc.querySelector(".hpcx-editor").textContent, "随便写点", "失败不能清草稿");
      ok(/发送失败/.test(e2.doc.querySelector("[data-composer-status]").textContent), "状态行提示失败");
    });
    e2.w.close();

    /* —— 网络异常 —— */
    const f = await bootReply({ loggedIn: true, fetchStub: { reject: "boom" } });
    f.doc.querySelector(".hpcx-editor").textContent = "写点";
    click(f.w, f.doc.querySelector('.hpcx-send[data-md="reply"]'));
    await new Promise((r) => setTimeout(r, 50));
    check("网络异常不卡死按钮，也不清草稿", () => {
      const btn = f.doc.querySelector('.hpcx-send[data-md="reply"]');
      eq(btn.disabled, false, "按钮要恢复可点");
      ok(/发送失败/.test(f.doc.querySelector(".hpcx-toast").textContent), "提示失败");
      eq(f.doc.querySelector(".hpcx-editor").textContent, "写点", "草稿保留");
    });
    f.w.close();

    /* —— Ctrl+Enter —— */
    const g = await bootReply({ loggedIn: true });
    g.w.__fetchCalls.length = 0;
    const ed = g.doc.querySelector(".hpcx-editor");
    ed.textContent = "快捷键发送";
    ed.dispatchEvent(new g.w.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await new Promise((r) => setTimeout(r, 50));
    check("已登录时 Ctrl+Enter = 发表", () => eq(g.w.__fetchCalls.length, 1, "发了 1 次请求"));
    g.w.close();

    const h2 = await bootReply({ loggedIn: false });
    const ed2 = h2.doc.querySelector(".hpcx-editor");
    ed2.textContent = "未登录按快捷键";
    ed2.dispatchEvent(new h2.w.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true, cancelable: true
    }));
    await new Promise((r) => setTimeout(r, 30));
    check("未登录时 Ctrl+Enter 退化成复制草稿（不发请求）", () => {
      eq(h2.w.__fetchCalls.length, 0, "不该发请求");
      // jsdom 没有剪贴板实现，copyText 会走到「复制失败」分支 —— 两种都算走了复制路径
      const t = h2.doc.querySelector(".hpcx-toast").textContent;
      ok(/已复制|复制失败/.test(t), "应走复制路径，实际提示: " + t);
    });
    h2.w.close();
  }

  /* ---------- 5.7 点亮 / 发新帖 ---------- */
  console.log("\n▶ 点亮（light / cancelLight）");
  {
    const loggedInPost = (extra) => {
      let h = fs.readFileSync(path.join(FIXTURES, "post.html"), "utf8");
      // euid 非空 = 已登录；同时把当前用户 puid 也改成真实值
      h = h.replace('"euid":""', '"euid":"190905797171683"');
      h = h.replace('"user":{"puid":"0"}', '"user":{"puid":"42102540"}');
      if (extra) h = extra(h);
      return h;
    };
    const bootLight = (opts) => boot("post.html", "https://bbs.hupu.com/642400850.html", null, {
      htmlOverride: opts && opts.html,
      fetchStub: (opts && opts.fetchStub) || { ok: true, body: { code: 200 } }
    });

    const a = await bootLight({ html: loggedInPost() });
    const btn = a.doc.querySelector('.hpcx-act[data-act="light"]');
    check("楼层操作里有「亮」按钮，带 pid", () => {
      ok(btn, "按钮存在");
      ok(btn.dataset.pid, "带 pid: " + btn.dataset.pid);
      eq(btn.dataset.lit, "0", "初始未点亮");
      eq(btn.tagName, "BUTTON", "得是按钮，不能是跳转链接");
    });

    const countEl = btn.closest(".hpcx-turn").querySelector("[data-light-count]");
    const before = Number(countEl.textContent);
    a.w.__fetchCalls.length = 0;
    click(a.w, btn);
    await new Promise((r) => setTimeout(r, 40));
    check("点「亮」→ POST 到 reply/light，body 用数字 id", () => {
      const c = a.w.__fetchCalls[0];
      ok(c, "发起了请求");
      eq(c.url, "/pcmapi/pc/bbs/v1/reply/light", "接口");
      eq(c.opts.method, "POST", "方法");
      eq(c.opts.credentials, "include", "带 cookie");
      const b = JSON.parse(c.opts.body);
      eq(b.pid, Number(btn.dataset.pid), "pid 是数字");
      eq(b.tid, 642400850, "tid");
      eq(b.fid, 34, "fid");
      eq(b.puid, 42102540, "puid = 当前登录用户");
      eq(typeof b.deviceId, "string", "deviceId 是字符串");
    });
    check("点亮成功后本地立刻反映（按钮变已亮、数字 +1）", () => {
      eq(btn.dataset.lit, "1", "状态");
      ok(btn.classList.contains("on"), "高亮样式");
      eq(btn.querySelector("span").textContent, "已亮", "文案");
      eq(Number(countEl.textContent), before + 1, "计数 " + before + " → " + countEl.textContent);
      ok(/已点亮/.test(a.doc.querySelector(".hpcx-toast").textContent), "提示");
    });

    a.w.__fetchCalls.length = 0;
    click(a.w, btn);
    await new Promise((r) => setTimeout(r, 40));
    check("再点一次 → 走 cancelLight，计数 −1", () => {
      eq(a.w.__fetchCalls[0].url, "/pcmapi/pc/bbs/v1/reply/cancelLight", "接口");
      eq(btn.dataset.lit, "0", "状态回未点亮");
      eq(Number(countEl.textContent), before, "计数回到 " + before);
      eq(btn.querySelector("span").textContent, "亮", "文案");
    });
    a.w.close();

    /* —— 服务端说已点亮 → 一上来就是已亮 —— */
    const b3 = await bootLight({ html: loggedInPost((h) => h.replace('"allLightCount":396', '"allLightCount":396,"isLighted":true')) });
    check("数据里 isLighted=true → 按钮初始就是已亮", () => {
      // 注意别只看第一个：文档里第一个「亮」按钮属于亮评区，patch 命中的是普通楼层
      const lit = [...b3.doc.querySelectorAll('.hpcx-act[data-act="light"]')]
        .filter((x) => x.dataset.lit === "1");
      ok(lit.length > 0, "应该有已亮的按钮，实际 " + lit.length + " 个");
      eq(lit[0].querySelector("span").textContent, "已亮", "文案");
      const notLit = [...b3.doc.querySelectorAll('.hpcx-act[data-act="light"]')]
        .filter((x) => x.dataset.lit === "0");
      ok(notLit.length > 0, "其余楼层应该还是未点亮");
    });
    b3.w.close();

    /* —— 未登录 —— */
    const c3 = await bootLight({ html: null });
    c3.w.__fetchCalls.length = 0;
    click(c3.w, c3.doc.querySelector('.hpcx-act[data-act="light"]'));
    await new Promise((r) => setTimeout(r, 40));
    check("未登录点亮 → 提示登录，不发请求", () => {
      eq(c3.w.__fetchCalls.length, 0, "请求数");
      ok(/登录/.test(c3.doc.querySelector(".hpcx-toast").textContent), "提示登录");
    });
    c3.w.close();

    /* —— 服务端拒绝 —— */
    const d3 = await bootLight({
      html: loggedInPost(),
      fetchStub: { ok: true, body: { code: 0, internalCode: "AS021999", msg: "内容数据出现异常，请稍后再试试" } }
    });
    const dbtn = d3.doc.querySelector('.hpcx-act[data-act="light"]');
    click(d3.w, dbtn);
    await new Promise((r) => setTimeout(r, 40));
    check("点亮失败时状态不能变，并把 msg 透出来", () => {
      eq(dbtn.dataset.lit, "0", "不能假装点亮成功");
      ok(/异常|稍后再试/.test(d3.doc.querySelector(".hpcx-toast").textContent),
        d3.doc.querySelector(".hpcx-toast").textContent);
      eq(dbtn.disabled, false, "按钮要恢复可点");
    });
    d3.w.close();
  }

  console.log("\n▶ 发新帖（createThread）");
  {
    const LOGIN_TOPIC = [['{"topic":{"isLogin":false', '{"topic":{"isLogin":true']];
    const loginTopic = () => {
      let h = fs.readFileSync(path.join(FIXTURES, "topic-daily.html"), "utf8");
      for (const [from, to] of LOGIN_TOPIC) h = h.replace(from, to);
      return h;
    };
    const bootPub = (opts) => boot("topic-daily.html", "https://bbs.hupu.com/topic-daily", null, {
      htmlOverride: (opts && opts.html) !== undefined ? opts.html : loginTopic(),
      fetchStub: (opts && opts.fetchStub) || { ok: true, body: { code: 200, data: { url: "/642999999.html" } } }
    });

    const a = await bootPub({});
    const entry = a.doc.querySelector("[data-publish]");
    check("版块列表页有「发新帖」入口", () => ok(entry, "入口存在"));
    check("列表页的输入框提示不能说「未登录」（已登录时）", () => {
      const hint = a.doc.querySelector(".hpcx-composer-hint").textContent;
      ok(!/未登录/.test(hint), "已登录却被写成未登录: " + hint);
      ok(/随手记|本地/.test(hint), "应说明是本地草稿: " + hint);
      eq(a.doc.querySelector('.hpcx-send[data-md="reply"]'), null,
        "列表页没有可回复的对象，不该有发表按钮");
    });

    click(a.w, entry);
    const modal = a.doc.querySelector(".hpcx-publish");
    check("点开弹框，带上当前版块名", () => {
      ok(modal && modal.hidden === false, "弹框可见");
      eq(modal.querySelector("[data-pub-board]").textContent, "步行街主干道", "版块名");
      ok(modal.querySelector("[data-pub-native]").href.endsWith("/post/1"),
        "退路链接: " + modal.querySelector("[data-pub-native]").href);
    });

    /* —— 空标题 / 空正文都不发请求 —— */
    a.w.__fetchCalls.length = 0;
    click(a.w, modal.querySelector("[data-pub-submit]"));
    await new Promise((r) => setTimeout(r, 30));
    check("标题为空时不发请求", () => {
      eq(a.w.__fetchCalls.length, 0, "请求数");
      ok(/标题/.test(modal.querySelector("[data-pub-status]").textContent), "提示标题");
    });
    modal.querySelector("[data-pub-title]").value = "测试标题";
    click(a.w, modal.querySelector("[data-pub-submit]"));
    await new Promise((r) => setTimeout(r, 30));
    check("正文为空时不发请求", () => {
      eq(a.w.__fetchCalls.length, 0, "请求数");
      ok(/正文/.test(modal.querySelector("[data-pub-status]").textContent), "提示正文");
    });

    /* —— 正常发布 —— */
    modal.querySelector("[data-pub-title]").value = "  我的新帖  ";
    modal.querySelector("[data-pub-content]").value = "**粗体**正文";
    a.w.__fetchCalls.length = 0;
    click(a.w, modal.querySelector("[data-pub-submit]"));
    await new Promise((r) => setTimeout(r, 40));
    check("发布请求打到 createThread，body 字段完整", () => {
      const c = a.w.__fetchCalls[0];
      ok(c, "发起了请求");
      eq(c.url, "/pcmapi/pc/bbs/v1/createThread", "接口");
      eq(c.opts.method, "POST", "方法");
      const b = JSON.parse(c.opts.body);
      eq(b.fid, "34", "fid");
      eq(b.topicId, "1", "topicId");
      eq(b.cateId, "1", "cateId");
      eq(b.title, "我的新帖", "标题要去首尾空白");
      ok(/<strong>粗体<\/strong>/.test(b.content), "正文转成 HTML: " + b.content);
      ok("nonce" in b && "shumeiId" in b, "nonce / shumeiId 要在");
    });
    check("成功后状态行标 OK", () => {
      const st = modal.querySelector("[data-pub-status]");
      eq(st.dataset.kind, "ok", "状态类型");
      ok(/成功/.test(st.textContent), st.textContent);
    });
    a.w.close();

    /* —— 服务端报错：弹框要留着，别把内容吐掉 —— */
    const b4 = await bootPub({
      fetchStub: { ok: true, body: { code: 0, internalCode: "PC022002", msg: "帖子内容不能为空" } }
    });
    click(b4.w, b4.doc.querySelector("[data-publish]"));
    const m4 = b4.doc.querySelector(".hpcx-publish");
    m4.querySelector("[data-pub-title]").value = "标题";
    m4.querySelector("[data-pub-content]").value = "正文";
    click(b4.w, m4.querySelector("[data-pub-submit]"));
    await new Promise((r) => setTimeout(r, 40));
    check("发布失败 → 透出 msg、弹框不关、内容不丢", () => {
      ok(/不能为空/.test(m4.querySelector("[data-pub-status]").textContent),
        m4.querySelector("[data-pub-status]").textContent);
      eq(m4.hidden, false, "弹框应该还开着");
      eq(m4.querySelector("[data-pub-title]").value, "标题", "标题还在");
      eq(m4.querySelector("[data-pub-content]").value, "正文", "正文还在");
    });

    check("Esc 关弹框", () => {
      key(b4.w, { key: "Escape" });
      eq(m4.hidden, true, "已关闭");
      eq(b4.doc.documentElement.classList.contains("hpcx-boss-on"), false, "不该误触伪装");
    });

    click(b4.w, b4.doc.querySelector("[data-publish]"));
    b4.w.__fetchCalls.length = 0;
    m4.querySelector("[data-pub-title]").value = "快捷发布";
    m4.querySelector("[data-pub-content]").value = "正文";
    m4.dispatchEvent(new b4.w.KeyboardEvent("keydown", {
      key: "Enter", ctrlKey: true, bubbles: true, cancelable: true
    }));
    // 先把请求等完再断言（check() 不会 await 回调返回值，所以别把异步塞进去）
    await new Promise((r) => setTimeout(r, 60));
    check("弹框里的 Ctrl+Enter = 发布", () => {
      eq(b4.w.__fetchCalls.length, 1, "发起了 1 次请求");
      eq(b4.w.__fetchCalls[0].url, "/pcmapi/pc/bbs/v1/createThread", "接口");
    });
    b4.w.close();

    /* —— 未登录 —— */
    const c4 = await bootPub({ html: null });
    c4.w.__fetchCalls.length = 0;
    click(c4.w, c4.doc.querySelector("[data-publish]"));
    await new Promise((r) => setTimeout(r, 30));
    check("未登录点发帖 → 提示登录，不开弹框", () => {
      const m = c4.doc.querySelector(".hpcx-publish");
      ok(!m || m.hidden === true, "弹框不该打开");
      ok(/登录/.test(c4.doc.querySelector(".hpcx-toast").textContent), "提示登录");
    });
    c4.w.close();
  }

  console.log("\n▶ 折叠与灯箱");
  {
    const { w, doc, errors } = await boot("p642395849.html", "https://bbs.hupu.com/642395849.html");

    const think = doc.querySelector(".hpcx-think");
    check("思考块默认展开（detailThinkingOpen=true）", () => ok(think.classList.contains("open"), "open"));
    click(w, think.querySelector(".hpcx-think-head"));
    check("点标题收起", () => eq(think.classList.contains("open"), false, "已收起"));
    click(w, think.querySelector(".hpcx-think-head"));
    check("再点展开", () => eq(think.classList.contains("open"), true, "已展开"));

    const quote = doc.querySelector(".hpcx-quote");
    if (quote) {
      const wasOpen = quote.classList.contains("open");
      click(w, quote.querySelector(".hpcx-quote-head"));
      check("引用卡片可折叠", () => eq(quote.classList.contains("open"), !wasOpen, "状态已翻转"));
    }

    const img = doc.querySelector(".hpcx-cooked img, .hpcx-turn-user-bubble img");
    click(w, img);
    check("点图开灯箱", () => {
      const lb = doc.querySelector(".hpcx-lightbox");
      ok(lb, "灯箱已创建");
      ok(lb.querySelector("img").src.length > 10, "灯箱里有图");
    });
    key(w, { key: "Escape" });
    check("Esc 关灯箱（且不触发伪装）", () => {
      eq(doc.querySelector(".hpcx-lightbox"), null, "灯箱已移除");
      eq(doc.documentElement.classList.contains("hpcx-boss-on"), false, "没误触发伪装");
    });

    check("全流程无报错", () => eq(errors.length, 0, errors.join(" | ")));
    w.close();
  }

  /* ---------- 5. rail 折叠 / 搜索 / 非接管路由 ---------- */
  console.log("\n▶ rail 与搜索");
  {
    const { w, doc, errors } = await boot("topic-daily.html", "https://bbs.hupu.com/topic-daily");

    /*
     * 回归：rail 的点击监听器早前是在 renderRail() 里用 { once: true } 挂的，
     * 而 renderRail 每次 render() 都重跑 —— 监听器随渲染次数叠加，
     * 一次点击被处理 N 次：分类折叠「开了又关」（看起来没反应）、
     * 明暗被切奇偶次、搜索弹多个 prompt。
     * 这里先故意触发几次重渲染，再验证点击行为仍然正确。
     */
    const rerender = (n) => {
      for (let i = 0; i < n; i++) {
        click(w, doc.querySelector('[data-set-toggle="codePanel"]'));
      }
    };
    openSettings4Test(w, doc);
    rerender(3);
    closeSettings4Test(w, doc);
    check("多次重渲染后分类折叠仍然一次点一次生效", () => {
      const isOpen = () => doc.querySelector(".hpcx-cat").classList.contains("open");
      const a = isOpen();
      click(w, doc.querySelector(".hpcx-cat [data-cat-toggle]"));
      const b = isOpen();
      click(w, doc.querySelector(".hpcx-cat [data-cat-toggle]"));
      const c = isOpen();
      ok(b !== a && c !== b, `期望 a→!a→a，实际 ${a}→${b}→${c}`);
    });
    check("多次重渲染后明暗切换只切一次", () => {
      const isLight = () => doc.documentElement.classList.contains("hpcx-light");
      const before = isLight();
      click(w, doc.querySelector("[data-mode-toggle]"));
      eq(isLight(), !before, "主题翻转一次（不是奇数/偶数次抵消）");
    });

    const cat = doc.querySelector(".hpcx-cat");
    const openBefore = cat.classList.contains("open");
    click(w, cat.querySelector("[data-cat-toggle]"));
    check("点分类箭头折叠/展开", () => {
      eq(doc.querySelector(".hpcx-cat").classList.contains("open"), !openBefore, "状态翻转");
    });

    const railItemsBefore = doc.querySelectorAll(".hpcx-rail-item").length;
    click(w, doc.querySelector("[data-rail-topics-toggle]"));
    check("常用专区「全部」展开", () => {
      ok(doc.querySelectorAll(".hpcx-rail-item").length >= railItemsBefore, "项目数没减少");
    });

    key(w, { key: "k", ctrlKey: true });
    check("Ctrl+K 触发搜索（打开站内搜索）", () => {
      ok(w.__opened && w.__opened.indexOf("/search?q=") > 0, "打开的 URL: " + w.__opened);
      ok(decodeURIComponent(w.__opened).includes("乔丹"), "query 正确编码");
    });

    // 在输入框里按 Ctrl+K 不应触发
    const input = doc.createElement("input");
    doc.body.appendChild(input);
    w.__opened = null;
    input.dispatchEvent(new w.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    check("输入框里的 Ctrl+K 不抢", () => eq(w.__opened, null, "没打开新页"));

    check("全流程无报错", () => eq(errors.length, 0, errors.join(" | ")));
    w.close();
  }

  /* ---------- 5.5 启动遮罩（不闪原样式） ---------- */
  console.log("\n▶ 启动遮罩 / 数据缓存");
  {
    /*
     * jsdom 里脚本是文档解析完之后才 eval 的，所以复现不了真实闪烁。
     * 真正的时序测试在 timing.js。这里只钉住两个可直接观察的不变量：
     *   1. 接管成功的页面上不能残留 hpcx-boot（否则多一层 hidden 白挂着）；
     *   2. 未接管的页面上 boot 必须摘掉、原生内容要回来。
     */
    const a = await boot("topic-daily.html", "https://bbs.hupu.com/topic-daily");
    check("接管成功后 hpcx-boot 已摘掉、hpcx-locked 生效", () => {
      const cl = a.doc.documentElement.classList;
      eq(cl.contains("hpcx-boot"), false, "boot 已摘");
      eq(cl.contains("hpcx-locked"), true, "locked 生效");
      eq(cl.contains("hpcx"), true, "hpcx 根标记在");
    });
    a.w.close();

    const b = await boot("hp_search.html", "https://bbs.hupu.com/search?q=%E4%B9%94%E4%B8%B9");
    check("真实搜索页（$$data 有 topic 但 threads 为空）不被误接管", () => {
      eq(b.doc.querySelector(".hpcx-main"), null, "没有 main");
      const cl = b.doc.documentElement.classList;
      eq(cl.contains("hpcx-boot"), false, "boot 已摘（原生页面要还回来）");
      eq(cl.contains("hpcx-locked"), false, "没有 lock");
      ok(b.doc.querySelector(".hpcx-rail"), "rail 仍在");
    });
    b.w.close();
  }

  /* ---------- 6. 非接管路由 ---------- */
  console.log("\n▶ 非接管路由 /search");
  {
    const { w, doc, errors } = await boot("post.html", "https://bbs.hupu.com/search?q=test");
    check("只挂 rail，不接管主区，原生内容可见", () => {
      ok(doc.querySelector(".hpcx-rail"), "rail 在");
      eq(doc.querySelector(".hpcx-main"), null, "main 不在");
      eq(doc.documentElement.classList.contains("hpcx-locked"), false, "没 lock（原生 #__next 仍显示）");
    });
    check("无报错", () => eq(errors.length, 0, errors.join(" | ")));
    w.close();
  }

  console.log("\n────────────────────────────");
  console.log("通过 " + pass + " / 失败 " + fail);
  if (failures.length) console.log("失败项: " + failures.join(", "));
  process.exit(fail ? 1 : 0);
})();
