# 测试与截图

针对 `../hupu-codex.user.js` 的七层验证（共 284 条断言）。全部**离线**跑：
只访问本地 HTTP 服务，外站请求一律 abort，所以不依赖虎扑是否能访问，也不会给它发多余请求。

```bash
npm install     # jsdom（解析/交互）+ playwright-core（驱动本机 Chrome，不下载浏览器）
npm test        # = unit && run && interact && login && images && timing && browser
npm run shots   # 生成截图到 shots/（含启动瞬间、登录态对照）
```

单独跑：

```bash
node unit.js       # 纯函数（高亮器 / 假代码 / markdown / num）
node run.js        # 数据解析
node interact.js   # 交互行为
node login.js      # 登录态显示
node images.js     # 图片尺寸 / 保真
node timing.js     # 启动时序（不闪原样式）
node browser.js    # 真实浏览器布局
node shots.js      # 常规截图
node bootshot.js   # “启动中”那一帧的截图
```

## 七层各管什么

### `unit.js` —— 纯函数（35 条）

从源码里把函数抠出来单独跑。这一层的价值在于：这类 bug 在截图上很难看出来。

最典型的是 `highlightCode` 的**占位符 bug**（从参考脚本继承的）：它把字符串字面量换成
`"\u0001<序号>\u0002"` 暂存，而紧接着的「数字高亮」会把序号也包成 `<span class="tk-n">`，
还原正则就再也匹配不到 —— 结果是字符串整段消失、正文里漏出裸控制字符。
截图上看只是一个小红框，不看代码根本不会注意到。现在的断言会遍历
**5 种语言 × 全部代码块**，逐行比对「剥掉标签后的可见字符」和原文。

其余：假代码不许重复 block、生成顺序稳定、markdown 转义（防注入）、
`num()` 对 `"655 / 24618"` 只取第一段。

### `run.js` —— 数据解析（11 条，jsdom）

用真实的虎扑页面对 `collectPage()` 的结果做断言。jsdom 会执行内联脚本，
所以 `window.$$data` / `#__NEXT_DATA__` 是真的被解析出来的，不是 mock。

覆盖：版块页、版块第 2 页、分类页、首页、帖子详情、帖子第 2 页、
三个排序变体（`-postdate` / `-hot` / `-hot-2`）、纯图片帖、非接管路由。

重点断言：

- 帖子行数、楼层数（含「17 亮评 + 20 楼层 = 37」这种容易搞错的口径）
- 楼层号连续、`id` 不重复、装饰种子稳定
- 排序 chip 唯一高亮；**第 2 页 URL 是 `/topic-daily-postdate-2` 而不是 `/topic-daily-2-postdate`**
- 标签页标题被伪装成源码文件名
- 图片帖不会被误判成「正文为空」

### `interact.js` —— 交互行为（90 条，jsdom）

真的派发键盘/鼠标事件，断言状态变化。键盘事件派发到 `body` 而不是 `window` ——
直接发给 `window` 会跳过 `document` 上的监听器，和浏览器行为不一致（这个坑踩过一次）。

覆盖：应急伪装（两下 Esc / Ctrl+Shift+H）、设置面板（开关/滑块/下拉/改语言/恢复默认/持久化）、
草稿板（输入落盘、点「回复」写入引用、markdown 工具栏与预览、清空）、
引用卡片与思考块折叠、灯箱开关、rail 分类折叠、`Ctrl+K` 搜索。

其中一条专门盯住「假代码不许重复 block」：逐个语言切换后统计重复的声明行，
必须为 0（早前版本会把同一个 `pub struct` 连着打四五遍）。

### `login.js` —— 登录态（25 条，jsdom）

盯「登录后切专区显示未登录」这个 bug。测试里无法真登录，所以改成
把 fixture 的 HTML 做**精确字符串替换**，把数据改成已登录的样子：

| 页面类型 | 要改的字段 |
|---|---|
| 版块页 | `{"topic":{"isLogin":false` → `true` |
| 首页 / 分类页 | 顶层 `"isLogin":false` 与 `"pageData":{"isLogin":false` 两处 |
| 帖子详情页 | `"euid":""` → `"euid":"190905797171683"` |

`loggedInHtml()` 会断言每个 `from` 字符串在文件里**恰好出现一次**，
否则直接报错 —— 将来虎扑改格式时测试会大声失败，而不是静默失真。

每个页面都验两面（已登录 → 「我的虎扑」，未登录 → 「未登录 · 去登录」），
另有一组穷举 `euid` × `puid` 组合的用例：

| euid | puid | 期望 | 理由 |
|---|---|---|---|
| 非空 | 非 0 | 已登录 | 两个信号一致 |
| 空 | `"0"` | 未登录 | 真实未登录页就是这样 |
| 非空 | `"0"` | 已登录 | 矛盾 → 倾向已登录（误报未登录最坑） |
| 缺失 | 非 0 | 已登录 | 只靠 puid 也能判 |
| 缺失 | `"0"` | 未登录 | |
| 缺失 | 缺失 | 中性文案 | 没信号就不猜 |

把修复回退掉，它会精确在**版块页 + 详情页**报错（13 条失败），
而首页与分类页全部通过 —— 和「切专区才变未登录」的报障完全一致。

### `images.js` —— 图片尺寸 / 保真（15 条，本机 Chrome）

盯「正文图片尺寸设置对表情图无效」。**这一层的难点是造可测量的图**：

- jsdom 不算布局，也拿不到 naturalWidth；
- 真实虎扑图片尺寸不可控，而且要靠网络。

所以它自己起一个服务器，并且**按虎扑 URL 里的尺寸提示伪造对应大小的 SVG**：

```
..._o_w_449_h_367_....jpg?x-oss-process=image/resize,w_225/...   → 返回 225x184
..._o_w_46_h_46_....GIF?x-oss-process=image/resize,w_800/...     → 返回  46x46
```

这样 naturalWidth 完全可控，才能断言「谁该响应设置、谁不该」。

断言分两组：

| 组 | 断言 |
|---|---|
| 保真 | 数据里每张图都渲染了、**出现次数也逐条一致**、单引号 src 的图在、url 带 `>` 的图在、没有空 img |
| 尺寸 | 所有图 ≤ 上限、没有图的 `max-width` 被硬编码、超上限的全跟着变、「表情尺寸区间(高 91~180px)」全部响应、小于上限的不被放大 |

其中最后一条（「就算被加上旧版的 hpcx-img-sm 类，尺寸依然听设置的」）是专门针对那个
硬编码 180px 规则的：因为原 bug 依赖内存缓存竞争（不确定复现），
测试干脆**手动把那个类补上**，模拟“当时运气好命中了”的情况。

`make-broken.js` 能把修复分别回退成三个版本，用来验证这层测试真的抓得住：

```bash
node make-broken.js css    broken.js   # 恢复硬编码 180px 规则
node make-broken.js single broken.js   # 属性提取只认双引号
node make-broken.js gt     broken.js   # 标签扫描回到 [^>]*
SCRIPT=$PWD/broken.js node images.js
```

三个都会精确报错（分别 1 / 1 / 3 条），说明这层不是在走过场。

### 回帖（写在 `unit.js` / `interact.js` / `browser.js` 里）

回帖是唯一真正写站点的功能，所以三层都盯：

| 层 | 盯什么 |
|---|---|
| `unit.js` | `buildReplyPayload` 的字段名/类型（tid/fid/topicId/content 都必须是字符串）、楼中楼要带 `pid` + `data.atc_content`、缺字段给空串不给 `null`、`draftToHtml` 的转义、`replyErrorText` 认 `msg` |
| `interact.js` | 已登录才出「回复」按钮；空内容不发请求；**请求打到哪个接口、body 长什么样**；成功后清草稿；服务端报错时把 `msg` 透出来且**不清草稿**；网络异常后按钮要恢复可点；`Ctrl+Enter` 在未登录时退化成复制 |
| `browser.js` | 已登录时按钮渲染成主按钮、工具栏不溢出、引用条是强调色且过长不撑破布局、楼中楼模式下正文里只留 `@` 不留 `>` 引用块 |

几个测试上的讲究：

- **成功分支只能靠打桩**：`interact.js` 给 `window.fetch` 装了个桩（jsdom 本来也没有 fetch），
  把请求参数记下来供断言。真实连通性用 curl 单独确认过 ——
  未登录 POST 会回 `{"code":0,"internalCode":"PC022003","msg":"用户未登录"}`，
  说明接口存在且确实在查登录态。
- **登录态要造**：详情页的登录信号只有 `pageProps.euid`，所以
  `/642400850.html?login=1` 这个路由会把 fixture 的 `euid` 改成非空再返回。
  注意必须挂在同一个 pathname 上 —— 脚本只按 pathname 判路由，
  换个路径名会被当成「不支持的路由」，主区根本不接管（这个坑踩过）。
- **`patches` 必须是「对的列表」**：`[['a','b']]` 而不是 `['a','b']`。
  写成后者时 `for (const [a, b] of patches)` 会去解构字符串，
  于是 `a` 变成单个字符、`h.split('"')` 数出上万个"出现次数"，报错信息还完全看不懂。

### 点亮 / 发新帖（写在 `unit.js` / `interact.js` 里）

两个都是**写接口**，所以重点全在「请求形状」和「失败时别装成功」：

| 功能 | `unit.js` 钉什么 | `interact.js` 钉什么 |
|---|---|---|
| 点亮 | `buildLightPayload` 的四个 id 必须是 **number**（站点代码里都做了 `+` 强转）、`puid` 取的是当前登录用户、拿不到时给 0 而不是 `NaN`；`isApiOk` 认站点那四种成功写法（`200`/`"200"`/`1`/`status:200`） | 点一下 → POST `reply/light` + body 是数字；本地计数 +1、按钮变「已亮」；再点 → 走 `cancelLight` 且 −1；数据里 `isLighted` 为真时开局就是已亮；未登录只提示不发请求；**服务端拒绝时状态不能变** |
| 发新帖 | `buildThreadPayload` 的字段名（`fid`/`topicId`/`cateId`/`title`/`content`/`nonce`/`shumeiId`）、标题 trim、缺字段给空串 | 入口在版块页、弹框带版块名、**空标题/空正文都不发请求**、body 字段完整且正文转成了 HTML、失败时**弹框不关、内容不丢**、Esc 关、`Ctrl+Enter` 发布、未登录不开弹框 |

两个测试上的坑（都踩过）：

- **`check()` 不会 await 回调的返回值**。一开始把 `return new Promise(...)` 写在 `check` 里，
  结果断言在 `window.close()` 之后才跑，报出「`document` is undefined」这种莫名其妙的错。
  异步要先 `await` 完再断言。
- **别只挑第一个匹配元素**。文档里第一个「亮」按钮属于**亮评区**，
  而 fixture 的 patch 命中的是普通楼层 —— 断言「存在已亮的按钮」比断言「第一个按钮已亮」稳得多。



亮评区从「一条染色的分隔线」改成了独立卡片，所以三层各盯一段：

| 层 | 盯什么 |
|---|---|
| `run.js` | 结构：`.hpcx-lights` 唯一、区内 17 条、有可点的标题行、默认不折叠、排在普通回复之前 |
| `interact.js` | 行为：点标题折叠/展开、折叠只影响这一块、取色器与浓度滑块即时生效并落盘、「无」把浓度归零、`lightsCollapsed:true` 开局就折叠、`showLights:false` 整块不渲染 |
| `browser.js` | 视觉：**底色不是透明的**、有边框圆角、区内楼层左边线与区外**不同色**、折叠后 body 高度归零、换色+调浓度后 alpha 确实变大、箭头方向对得上状态 |

`browser.js` 里有一条坑值得单说：Chrome 把 `color-mix()` 的结果算成
`color(srgb r g b / a)` 而不是 `rgba()`，所以断言不能直接比字符串，
得自己从两种序列化里都抽出 alpha 来比。

### `timing.js` —— 启动时序（33 条，本机 Chrome）

专门盯「初次打开闪一下虎扑原样式」这个 bug。它是唯一一个**必须自己造网络条件**才能复现的：

- jsdom 里脚本是文档解析完之后才 eval 的，`$$data` 早就有了，怎么写都测不出来；
- 直接跑真实 URL 也不行 —— 虎扑那一刻的变化不可控。

所以它自己起一个分块服务器：**前半段 HTML 立刻发，含 `$$data` / `__NEXT_DATA__` 的后半段延迟 400ms**，
精确复现「document-start 跑脚本时数据还没到」这个真实情況；
再用 `addInitScript` 从 document-start 开始每 10ms 采样：
原生容器是否可见、body 上有没有露出别人的节点、rail/main 什么时候出现。

断言：

| 路由 | 断言 |
|---|---|
| 会被接管的 6 个页面 | 原生内容**一次都不能可见**（包括 `#container` 和 body 上的 portal） |
| 同上 | rail 必须在数据到来前就画出来（否则就是纯色空白） |
| 同上 | 数据到齐后必须完成接管，并且摘掉 `hpcx-boot` |
| 搜索页（不接管） | 遮罩必须摘掉、原生页面要能回来，而且不能永久挂着 |

`BODY_DELAY=900 node timing.js` 可以拉长延迟手工看效果（配合 `node bootshot.js` 截图）。

往 `pageData()` 里把「空结果不缓存」改回去，这个测试会精准地在 4 个列表页上报错；
而 2 个详情页不受影响（它们光看路径就能判定接管）—— 这正好对应
用户截图里「版块页闪、点进去就不闪」的现象。

### `browser.js` —— 真实浏览器（75 条，本机 Chrome/Edge）

jsdom 不做布局，所以这部分只能真跑。会自动找
`C:\Program Files\Google\Chrome\Application\chrome.exe`
或 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。

覆盖：rail/面板实际宽度、main 是否横向溢出、页面本身不滚动（滚动发生在 `.hpcx-thread` 里）、
原生容器是否真的 `display:none`、明暗 token 的计算值、图片失败兜底、缩略图尺寸约束、
灯箱、两栏拖拽调宽与双击复位、1180/860px 两个响应式断点、
伪装视图铺满视口且正文不可见。

其中「悬停预览的位置」一组是专门钉住「预览跑到右下角」那个 bug 的：
测试把缩略图用 `position:fixed` 钉在视口里的指定坐标（rect 完全可控），
再逐一验证四种情况 —— 右侧有地方就贴右侧（gap ≈ 12px）、右侧放不下就翻到左侧、
两边都放不下就夹在视口内不越界、**大图还没下载完时位置就已经是对的**。
最后一条要配合服务器上的 `/slow-image.svg`（延迟 600ms 返回）才能测。

回退修复（CSS 改回 `right/bottom` + 去掉定位）后这组会挂 5 条，
其中一条直接报 `prev.right=1582 prev.bottom=982` —— 正好是 `1600-18 / 1000-18`，
把「贴在右下角」这件事坐实了。

### `shots.js` / `bootshot.js` —— 截图

`shots.js` 生成 14 张图到 `shots/`（含 `14-hover-preview` 悬停预览定位）（含两张登录态对照 `12-login-topic` / `13-login-post`，
它们由 `OVERRIDES` 把 fixture 改成已登录后拍）；另有多张 `zoom-*.png` 是局部放大，用于看细节。
`bootshot.js` 另外抓两张：**启动中**那一帧（`00-boot-state.png`，用 900ms 延迟放大窗口）
和接管完成后的对照（`00-after-boot.png`）。
跑完会报告有没有控制台报错（外站资源 abort 造成的 `Failed to load resource` 已过滤）。

> 小坑：`.hpcx-rail` 上有 `transition: transform .22s`，从窄屏拉伸回宽屏后如果立刻截图，
> 会拍到抽屉滑到一半的状态。截图前得等一下。

## fixtures

抓下来的真实页面，直接喂给测试：

| 文件 | 对应 URL |
|---|---|
| `topic-daily.html` | `/topic-daily` |
| `hp_topic-daily-2.html` | `/topic-daily-2` |
| `hp_tdpostdate.html` | `/topic-daily-postdate` |
| `hp_tdhot.html` / `hp_tdhot2.html` | `/topic-daily-hot`、`/topic-daily-hot-2` |
| `hp_td2postdate.html` / `hp_td3hot.html` | 不存在的 URL（用来验证「静默回退到首页数据」这个坑） |
| `hp_all-gambia.html` | `/all-gambia`（分类页，`pageData` 结构） |
| `hp_home.html` | `/`（首页，带 `careListInfo`） |
| `post.html` | `/642400850.html`（17 亮评 + 20 楼层，含 25 条引用） |
| `p642400850-2.html` | `/642400850-2.html`（第 21-40 楼） |
| `p642395849.html` | `/642395849.html`（正文是长图） |
| `hp_search.html` | `/search?q=乔丹`（`$$data` 有 `topic` 但 `threads` 为空 —— 不能误当列表接管） |
| `p642423863.html` | 备用 |

要更新 fixtures，重新抓一份覆盖同名文件即可 —— 脚本读的是内嵌 JSON，
站点换类名哈希不影响测试。
