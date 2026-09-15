/**
 * 纯函数单元测试。这些函数不依赖页面，但出错了很难从截图上看出来，
 * 所以单独钉一遍（highlightCode 的占位符 bug 就是这么漏过去的）。
 *
 * 用法: node unit.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "hupu-codex.user.js"), "utf8");

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

// 把脚本内部的函数抠出来单独跑：脚本是 IIFE，只能从源码里截取片段
function extractFunctions(names) {
  const out = [];
  for (const n of names) {
    const m = SCRIPT.match(new RegExp("\\n  function " + n + "\\([\\s\\S]*?\\n  \\}"));
    if (!m) throw new Error("找不到函数 " + n);
    out.push(m[0]);
  }
  return out.join("\n");
}

const code = [
  "const DEFAULTS = {};",
  extractFunctions(["escapeHtml", "num", "mulberry32", "highlightCode", "genCodeLines", "mdToHtml",
    "buildReplyPayload", "draftToHtml", "replyErrorText",
    "buildLightPayload", "isApiOk", "buildThreadPayload"]),
  (SCRIPT.match(/const CODE_LANGS = \{[\s\S]*?\n  \};/) || [])[0],
  "return { escapeHtml, num, mulberry32, highlightCode, genCodeLines, mdToHtml, CODE_LANGS, " +
    "buildReplyPayload, draftToHtml, replyErrorText, buildLightPayload, isApiOk, buildThreadPayload };",
].join("\n");

const api = new Function(code)();

console.log("\n▶ 点亮 payload（buildLightPayload）");

const LIGHT_THREAD = { tid: "642400850", fid: "34", myPuid: "42102540" };

check("四个 id 必须是**数字**（站点代码里都做了 + 强转）", () => {
  const p = api.buildLightPayload(LIGHT_THREAD, "78027", "DEV-1");
  ["pid", "tid", "puid", "fid"].forEach((k) => {
    eq(typeof p[k], "number", k + " 应该是 number");
  });
  eq(p.pid, 78027, "pid");
  eq(p.tid, 642400850, "tid");
  eq(p.fid, 34, "fid");
  eq(p.deviceId, "DEV-1", "deviceId 是字符串");
});

check("puid 用的是当前登录用户，不是被点亮那楼的作者", () => {
  const p = api.buildLightPayload(LIGHT_THREAD, "78027", "");
  eq(p.puid, 42102540, "取 thread.myPuid");
});

check("拿不到登录用户时 puid 为 0（不会变成 NaN）", () => {
  const p = api.buildLightPayload({ tid: "1", fid: "2" }, "9", "");
  eq(p.puid, 0, "puid");
  ["pid", "tid", "puid", "fid"].forEach((k) => {
    ok(Number.isFinite(p[k]), k + " 不能是 NaN（JSON 会变成 null）: " + p[k]);
  });
});

check("deviceId 缺失给空串", () => {
  eq(api.buildLightPayload(LIGHT_THREAD, "1").deviceId, "", "默认空串");
  eq(api.buildLightPayload(LIGHT_THREAD, "1", null).deviceId, "", "null 也变空串");
});

console.log("\n▶ 接口成功判定（isApiOk）");

check("站点自己接受的四种写法都要算成功", () => {
  ok(api.isApiOk({ code: 200 }), "code:200");
  ok(api.isApiOk({ code: 1 }), "code:1");
  ok(api.isApiOk({ code: "200" }), 'code:"200"');
  ok(api.isApiOk({ status: 200 }), "status:200");
});

check("失败的不算成功", () => {
  // 真实失败形状：{"code":0,"internalCode":"PC022003","msg":"用户未登录"}
  ok(!api.isApiOk({ code: 0, internalCode: "PC022003", msg: "用户未登录" }), "code:0");
  ok(!api.isApiOk({ code: 400 }), "code:400");
  ok(!api.isApiOk({}), "空对象");
  ok(!api.isApiOk(null), "null");
});

console.log("\n▶ 发帖 payload（buildThreadPayload）");

const BOARD = { name: "步行街主干道", topicId: "1", cateId: "1", fid: "34" };

check("字段名与站点编辑器一致", () => {
  const p = api.buildThreadPayload(BOARD, "标题", "<p>正文</p>", "DEV-1");
  eq(p.fid, "34", "fid");
  eq(p.topicId, "1", "topicId");
  eq(p.cateId, "1", "cateId（编辑器 default 分支用的就是它）");
  eq(p.title, "标题", "title");
  eq(p.content, "<p>正文</p>", "content");
  eq(p.nonce, "", "nonce 给空串（站点自己也是 nonce:\"\"）");
  eq(p.shumeiId, "DEV-1", "shumeiId");
  ["videoCover", "videoUrl", "videoSource", "videoPreview"].forEach((k) => {
    eq(p[k], "", k + " 应为空串");
  });
});

check("标题去首尾空白，缺字段给空串", () => {
  eq(api.buildThreadPayload(BOARD, "  有空格  ", "<p>x</p>", "").title, "有空格", "trim");
  const p = api.buildThreadPayload({}, "", "", "");
  eq(p.fid, "", "fid");
  eq(p.cateId, "", "cateId");
  Object.entries(p).forEach(([k, v]) => {
    ok(v !== undefined && v !== null, k + " 不能是 undefined/null");
  });
});

console.log("\n▶ 回帖 payload（buildReplyPayload）");

// 从真实页面 fixture 里取到的字段值
const THREAD = { tid: "642400850", fid: "34", topicId: "1" };

check("顶层回复：必填字段齐、类型都是字符串", () => {
  const p = api.buildReplyPayload(THREAD, "<p>hello</p>", null, "");
  eq(p.tid, "642400850", "tid");
  eq(p.fid, "34", "fid");
  eq(p.topicId, "1", "topicId");
  eq(p.content, "<p>hello</p>", "content");
  eq(p.quoteId, "", "quoteId 默认空串");
  // 站内编辑器会带上这些字段，缺了可能被判参数错误
  ["videoCover", "videoUrl", "videoSource", "videoPreview", "shumeiId"].forEach((k) => {
    eq(p[k], "", k + " 应为空串");
  });
  ok(!("pid" in p), "顶层回复不该带 pid");
  ok(!("data" in p), "顶层回复不该带 data");
});

check("楼中楼：带 pid 和 data.atc_content", () => {
  const p = api.buildReplyPayload(THREAD, "<p>我的回复</p>",
    { pid: "78027", floor: "3", author: "某人", contentHtml: "<p>被引用的原文</p>" }, "");
  eq(p.pid, "78027", "pid");
  eq(p.data.atc_content, "<p>被引用的原文</p>", "atc_content 用被引用那一楼的原文");
  eq(p.content, "<p>我的回复</p>", "content 仍是本次输入");
  eq(p.tid, "642400850", "tid 仍在");
});

check("楼中楼但没拿到原文时，atc_content 退回用本次内容", () => {
  const p = api.buildReplyPayload(THREAD, "<p>abc</p>", { pid: "9", floor: "1" }, "");
  eq(p.data.atc_content, "<p>abc</p>", "不能是 undefined");
});

check("没有 pid 的 target 不算楼中楼（回复楼主就是顶层回复）", () => {
  const p = api.buildReplyPayload(THREAD, "<p>x</p>", { floor: "OP", author: "楼主" }, "");
  ok(!("pid" in p), "不该带 pid");
});

check("shumeiId 透传（风控设备号，站点用的是 SMSdk.getDeviceId()）", () => {
  eq(api.buildReplyPayload(THREAD, "<p>x</p>", null, "", "DEVICE-123").shumeiId,
    "DEVICE-123", "有就给过去");
  eq(api.buildReplyPayload(THREAD, "<p>x</p>", null, "").shumeiId, "",
    "拿不到就给空串（和站点自己的兜底一致）");
  eq(api.buildReplyPayload(THREAD, "<p>x</p>", null, "", null).shumeiId, "",
    "null 也要变空串，不能是 null");
});

check("quoteId 原样传进去", () => {
  const p = api.buildReplyPayload(THREAD, "<p>x</p>", null, "13579");
  eq(p.quoteId, "13579", "quoteId");
});

check("缺字段时给空串而不是 undefined（免得 body 里出现 null）", () => {
  const p = api.buildReplyPayload({}, "<p>x</p>", null, "");
  eq(p.tid, "", "tid");
  eq(p.fid, "", "fid");
  eq(p.topicId, "", "topicId");
  Object.entries(p).forEach(([k, v]) => {
    if (k !== "data") ok(v !== undefined && v !== null, k + " 不能是 undefined/null");
  });
});

console.log("\n▶ 草稿转 HTML（draftToHtml）");

check("段落包成 <p>，换行不丢", () => {
  const h = api.draftToHtml("第一段\n\n第二段");
  ok(/<p>第一段<\/p>/.test(h), h);
  ok(/<p>第二段<\/p>/.test(h), h);
});

check("markdown 标记能转过去", () => {
  const h = api.draftToHtml("**粗** 和 `code`");
  ok(/<strong>粗<\/strong>/.test(h), h);
  ok(/<code>code<\/code>/.test(h), h);
  // 引用得单独成行才算 blockquote（行内的 > 只是普通字符）
  ok(/<blockquote>/.test(api.draftToHtml("> 引用一行")), "独立的 > 行");
  ok(!/<blockquote>/.test(h), "行内的 > 不该变引用: " + h);
  ok(/<ul>/.test(api.draftToHtml("- 甲\n- 乙")), "列表");
});

check("空草稿 / 只有空白 → 空串（上层据此拦住不发送）", () => {
  eq(api.draftToHtml(""), "", "空串");
  eq(api.draftToHtml("   \n\t "), "", "全空白");
  eq(api.draftToHtml(null), "", "null");
});

check("用户输入的尖括号被转义（不会当 HTML 发上去）", () => {
  const h = api.draftToHtml('<img src=x onerror=alert(1)>');
  ok(!/<img/.test(h), "img 必须被转义: " + h);
});

console.log("\n▶ 错误文案（replyErrorText）");

check("优先用服务端原文（真实接口用的是 msg）", () => {
  // 实测形状：{"code":0,"internalCode":"PC022003","msg":"用户未登录"}
  eq(api.replyErrorText({ code: 0, internalCode: "PC022003", msg: "用户未登录" }), "用户未登录");
  eq(api.replyErrorText({ code: 400, message: "旧字段也认" }), "旧字段也认");
});

check("没 message 时按 code 给说法", () => {
  ok(/登录/.test(api.replyErrorText({ code: 401 })), "401 → 提示登录");
  ok(/登录/.test(api.replyErrorText({ code: 403 })), "403 → 提示登录");
  ok(/不合法|为空/.test(api.replyErrorText({ code: 4005 })), "4005 → 内容问题");
  ok(/code 999/.test(api.replyErrorText({ code: 999 })), "未知 code 要把 code 带出来");
  ok(/undefined/.test(api.replyErrorText({})), "连 code 都没有也要能显示");
  ok(/稍后再试|异常/.test(api.replyErrorText({ code: 0, internalCode: "AS021999", msg: "内容数据出现异常，请稍后再试试" })),
    "风控返回也要原样透出来");
});

console.log("\n▶ highlightCode（语法高亮）");

check("字符串字面量完整保留", () => {
  const L = api.CODE_LANGS.rust;
  const out = api.highlightCode('    return fmt.Errorf("refresh topic %d: %w", id, err)', L);
  ok(out.includes("refresh topic %d: %w"), "字符串内容不能丢: " + out);
  ok(out.includes('class="tk-s"'), "字符串要高亮成 tk-s");
  ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(out), "不能漏出控制字符: " + JSON.stringify(out));
});

check("字符串里的数字不会被当数字高亮（占位符回归测试）", () => {
  const L = api.CODE_LANGS.rust;
  // 占位符里带序号时，这一行会让序号被 <span class="tk-n"> 包住、还原失败
  const out = api.highlightCode('    assert_eq!(x, 1, "expected 42 items");', L);
  ok(!/[\u0001\u0002]/.test(out), "不能残留占位符: " + JSON.stringify(out));
  ok(out.includes("expected 42 items"), "字符串内容完整");
  // 字符串外的 1 还是要高亮
  ok(/tk-n">1</.test(out), "字符串外的数字仍要高亮");
});

check("多个字符串相邻也不串位", () => {
  const L = api.CODE_LANGS.typescript;
  const out = api.highlightCode('const a = "one", b = "two", c = "three";', L);
  const plain = out.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"');
  ok(plain.includes('"one"') && plain.includes('"two"') && plain.includes('"three"'), "三个都要在: " + plain);
  ok(!/[\u0001\u0002]/.test(out), "无残留占位符");
  eq((out.match(/tk-s/g) || []).length, 3, "三个字符串各一个 tk-s");
});

check("注释被单独高亮且不会被关键字规则打断", () => {
  const L = api.CODE_LANGS.python;
  const out = api.highlightCode("    return x  # 返回 fn 的 count", L);
  ok(out.includes('class="tk-c"'), "有注释高亮");
  ok(out.indexOf('class="tk-c"') > out.indexOf("return"), "注释在代码之后");
  ok(/tk-c"># 返回 fn 的 count/.test(out), "注释内容完整");
});

check("所有语言 × 所有代码块都能高亮，不抛错、不丢字符、不漏控制字符", () => {
  let nonEmpty = 0;
  for (const [key, L] of Object.entries(api.CODE_LANGS)) {
    const lines = api.genCodeLines(key);
    ok(lines.length >= 55, key + " 行数 " + lines.length);
    lines.forEach((l) => {
      const out = api.highlightCode(l, L);
      if (/[\u0001\u0002]/.test(out)) throw new Error(key + " 残留占位符: " + JSON.stringify(l));
      // 剥掉标签、还原实体之后，可见字符必须和原文一致（空行除外）
      const plain = out.replace(/<[^>]*>/g, "")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      if (l !== "" && plain !== l) {
        throw new Error(key + " 字符丢失\n  原: " + JSON.stringify(l) + "\n  出: " + JSON.stringify(plain) + "\n  html: " + out);
      }
      if (l !== "") nonEmpty++;
    });
  }
  ok(nonEmpty > 200, "覆盖了 " + nonEmpty + " 行非空代码");
});

console.log("\n▶ genCodeLines（假代码生成）");

check("每个 block 只出现一次（不重复）", () => {
  for (const key of Object.keys(api.CODE_LANGS)) {
    const lines = api.genCodeLines(key);
    const decls = lines.filter((l) => /^\s*(pub (struct|enum|fn|async)|def |class |func |public |interface |type |const |#\[|import |use |package )/.test(l));
    const dupes = decls.filter((l, i) => decls.indexOf(l) !== i);
    eq(dupes.length, 0, key + " 重复声明: " + JSON.stringify(dupes.slice(0, 3)));
  }
});

check("顺序稳定（同一语言每次生成完全一致）", () => {
  for (const key of Object.keys(api.CODE_LANGS)) {
    eq(api.genCodeLines(key).join("\n"), api.genCodeLines(key).join("\n"), key + " 不稳定");
  }
});

console.log("\n▶ mdToHtml（草稿预览）");

check("加粗 / 行内代码 / 链接", () => {
  const h = api.mdToHtml("**粗** 和 `code` 和 [链接](https://a.com)");
  ok(/<strong>粗<\/strong>/.test(h), h);
  ok(/<code>code<\/code>/.test(h), h);
  ok(/<a href="https:\/\/a\.com"/.test(h), h);
});

check("列表与引用", () => {
  const h = api.mdToHtml("- 甲\n- 乙\n\n> 引用一句");
  ok(/<ul>/.test(h) && /<li>甲<\/li>/.test(h) && /<li>乙<\/li>/.test(h), h);
  ok(/<blockquote>引用一句<\/blockquote>/.test(h), h);
});

check("HTML 被转义（不会变成注入）", () => {
  const h = api.mdToHtml('<img src=x onerror=alert(1)>');
  ok(!/<img/.test(h), "img 必须被转义: " + h);
  ok(/&lt;img/.test(h), h);
});

check("空草稿不炸", () => {
  ok(/hpcx-dim/.test(api.mdToHtml("")), "空内容给占位");
});

console.log("\n▶ 其它工具函数");

check("num 处理各种脏输入", () => {
  eq(api.num("655 / 24618"), 655, "只取第一段数字（用于回复数行）");
  eq(api.num(""), 0, "空串 → 0");
  eq(api.num(null), 0, "null → 0");
  eq(api.num(undefined), 0, "undefined → 0");
  eq(api.num("亮12"), 12, "字母数字混合");
  eq(api.num("1,234"), 1234, "带千分位");
  eq(api.num("1 天前"), 1, "带单位");
  eq(api.num("没有数字"), 0, "无数字 → 0");
  eq(api.num(0), 0, "数字 0 原样保留");
  eq(api.num("1789290610000"), 1789290610000, "13 位时间戳不被截断");
});

check("mulberry32 稳定且落在 [0,1)", () => {
  const a = api.mulberry32(42), b = api.mulberry32(42);
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()];
  eq(seqA.join(","), seqB.join(","), "同种子同序列");
  seqA.forEach((v) => ok(v >= 0 && v < 1, "范围 " + v));
  ok(api.mulberry32(43)() !== seqA[0], "不同种子不同序列");
});

check("escapeHtml 覆盖五类字符", () => {
  eq(api.escapeHtml('&<>"\''), "&amp;&lt;&gt;&quot;&#39;", "全部转义");
  eq(api.escapeHtml(null), "", "null → 空串");
});

console.log("\n────────────────────────────");
console.log("通过 " + pass + " / 失败 " + fail);
if (failures.length) console.log("失败项: " + failures.join(", "));
process.exit(fail ? 1 : 0);
