# 截图

README 里引用的截图放在这里，由 `npm run shots`（即 `test/shots.js` + `test/bootshot.js`）
用本机 Chrome 对 `test/fixtures/` 里的页面**真实渲染**出来的，不是手摆的图。

`test/shots/` 里是完整的测试产物（30 张，含各种边界态），整个目录 `.gitignore` 掉了；
这里只挑「一张能说明一件事」的 7 张，缩到 1600px 宽存成 WebP，加起来约 550KB。

| 文件 | 说明 |
|---|---|
| `01-list-dark.webp` | 版块列表，深色 |
| `02-thread-dark.webp` | 帖子详情，主楼当用户消息、回复当 agent 楼层 |
| `03-publish.webp` | 发新帖弹框 |
| `04-lights.webp` | 亮评区，可折叠、底色可调 |
| `05-settings.webp` | 设置面板 |
| `06-boss.webp` | 应急伪装视图 |
| `07-list-light.webp` | 浅色模式 |

## archive/

改造前的原生虎扑页面截图，以及开发过程中的中间态。**已 `.gitignore`，不进仓库** ——
里面的 UI 是旧的，提交进来会误导人。留在这里纯粹是为了本机存档、对比。

要换成当前版本的截图：

```bash
npm run shots                      # 重新生成 test/shots/
# 然后按上面的尺寸（1600px 宽 / WebP q80）压一遍挑中的那几张
```
