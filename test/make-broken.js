/**
 * 生成「只回退某一个修复」的脚本，用来验证 images.js 真的能抓到对应 bug。
 * 每个回退都尽量小，坏哪一条就只让哪一条断言挂。
 *
 * 用法: node make-broken.js <css|single|gt> [输出路径]
 */
const fs = require("fs");
const path = require("path");

const mode = process.argv[2];
const out = process.argv[3] || path.join(__dirname, "broken.js");
let s = fs.readFileSync(path.join(__dirname, "..", "hupu-codex.user.js"), "utf8");
const before = s;

function replaceOnce(from, to, label) {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`锚点 "${label}" 期望出现 1 次，实际 ${n} 次`);
  s = s.replace(from, to);
}

const CSS_IMG = "    .hpcx-cooked img, .hpcx-turn-user-bubble img, .hpcx-quote-body img {";
const TAG_NEW = '.replace(/<img\\b(?:"[^"]*"|\'[^\']*\'|[^>"\'])*>/gi, (m) => {\n        const a = m.slice(4, -1);   // 去掉 "<img" 和 结尾的 ">"';
const TAG_OLD = '.replace(/<img\\b([^>]*)>/gi, (m, a) => {';
const PICK_NEW = '        const pick = (name) => {\n' +
  '          const mm = a.match(new RegExp("\\\\s" + name + "\\\\s*=\\\\s*(?:\\"([^\\"]*)\\"|\'([^\']*)\'|([^\\\\s>]+))", "i"));\n' +
  '          if (!mm) return "";\n' +
  '          return mm[1] != null ? mm[1] : mm[2] != null ? mm[2] : (mm[3] || "");\n' +
  '        };';
const PICK_OLD = '        const pick = (name) => (a.match(new RegExp("\\\\s" + name + "=\\"([^\\"]*)\\"", "i")) || [])[1] || "";';

if (mode === "css") {
  // 恢复那条硬编码 180px 的规则（表情尺寸区间不再听设置的）
  replaceOnce(CSS_IMG, "    .hpcx-cooked img.hpcx-img-sm { max-width: 180px; max-height: 180px; }\n" + CSS_IMG, "css");
} else if (mode === "single") {
  // 属性取值只认双引号（单引号 src 的图会被删掉）
  replaceOnce(PICK_NEW, PICK_OLD, "pick");
} else if (mode === "gt") {
  // 标签扫描回到 [^>]*（url 里带 > 的图会被截断后删掉）
  replaceOnce(TAG_NEW, TAG_OLD, "tag");
} else {
  console.error("用法: node make-broken.js <css|single|gt> [输出路径]");
  process.exit(2);
}

if (s === before) throw new Error("什么都没改到");
fs.writeFileSync(out, s);
console.log("已写出回退版(" + mode + "):", out);
