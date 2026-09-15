/** 抓「启动中」那一瞬间（数据还没到）的画面，确认不是白屏/原样式 */
const fs=require("fs"),path=require("path"),http=require("http");
const {chromium}=require("playwright-core");
const ROOT=path.join(__dirname,".."),FIX=path.join(__dirname,"fixtures");
const CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe";
const DELAY=900;   // 故意放大到 900ms，好抓
(async()=>{
  const srv=http.createServer((q,r)=>{
    const u=new URL(q.url,"http://l");
    if(u.pathname!=="/topic-daily"){r.writeHead(404);r.end();return;}
    const html=fs.readFileSync(path.join(FIX,"topic-daily.html"),"utf8");
    const cut=Math.floor(html.length*0.5);
    r.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
    r.write(html.slice(0,cut));
    setTimeout(()=>r.end(html.slice(cut)),DELAY);
  });
  await new Promise(r=>srv.listen(0,"127.0.0.1",r));
  const b=await chromium.launch({executablePath:CHROME});
  const c=await b.newContext({viewport:{width:1500,height:900},deviceScaleFactor:2,colorScheme:"dark"});
  await c.route("**/*",rt=>rt.request().url().startsWith("http://127.0.0.1")?rt.continue():rt.abort());
  await c.addInitScript({content:fs.readFileSync(path.join(ROOT,"hupu-codex.user.js"),"utf8")});
  const p=await c.newPage();
  const go=p.goto(`http://127.0.0.1:${srv.address().port}/topic-daily`,{waitUntil:"commit"});
  await p.waitForTimeout(350);            // 数据还没到
  await p.screenshot({path:path.join(__dirname,"shots","00-boot-state.png")});
  const state=await p.evaluate(()=>({cls:document.documentElement.className, rail:!!document.querySelector(".hpcx-rail"), main:!!document.querySelector(".hpcx-main"), title:document.title}));
  console.log("启动中状态:", JSON.stringify(state));
  await go; await p.waitForTimeout(1200);
  await p.screenshot({path:path.join(__dirname,"shots","00-after-boot.png")});
  console.log("接管后 title:", await p.evaluate(()=>document.title));
  await b.close(); srv.close();
})();
