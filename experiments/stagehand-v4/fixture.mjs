import { createServer } from 'node:http';

/** 启动跨站点测试页面，不访问外部账户或调用模型。 */
export async function startFixture() {
  let port;
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const report = `function report(data) { parent.postMessage({fixture:true,...data}, '*'); }`;
    const content = {
      '/': `<!doctype html><meta charset="utf-8"><title>RealCode-shaped fixture</title>
        <style>body{font-family:sans-serif}#preview{position:fixed;right:0;top:60px;width:70%;height:70%;border:1px solid}iframe{width:100%;height:100%;border:0}</style>
        <h1>Conversation</h1><div id="preview"><iframe id="cross" name="realcode-floating-preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        src="http://localhost:${port}/form"></iframe></div>
        <script>window.fixtureEvents=[];addEventListener('message',e=>{if(e.data?.fixture)fixtureEvents.push(e.data)});</script>`,
      '/form': `<!doctype html><meta charset="utf-8"><title>Cross-site search</title>
        <style>body{margin:24px}input,button{padding:8px}#overlay{position:fixed;inset:0;background:#eee;z-index:99}iframe{width:100%;height:110px}</style>
        <form id="form"><label>搜索<input id="query" name="q"></label><button id="search">搜索</button></form>
        <p id="noise"></p><div id="result"></div>
        <button id="replace" type="button">Replace input</button><button id="block" type="button">Cover target</button>
        <a id="next" href="/next">Next page</a><a id="blank" href="/next" target="_blank">New tab link</a>
        <div id="shadow"></div><iframe id="nested" src="http://127.0.0.1:${port}/nested"></iframe>
        <script>${report}
        setInterval(()=>document.querySelector('#noise').textContent='Recommendation '+Date.now(),75);
        document.addEventListener('input',e=>report({kind:'input',value:e.target.value,trusted:e.isTrusted}));
        document.querySelector('#form').onsubmit=e=>{e.preventDefault();const q=document.querySelector('#query').value;
          setTimeout(()=>{document.querySelector('#result').textContent='结果：'+q;report({kind:'result',value:q});},120)};
        document.querySelector('#replace').onclick=()=>{const old=document.querySelector('#query');old.replaceWith(old.cloneNode())};
        document.querySelector('#block').onclick=()=>{const d=document.createElement('div');d.id='overlay';
          d.innerHTML='<button id="dismiss">Dismiss</button>';document.body.append(d);
          d.onclick=()=>report({kind:'overlay-click'});d.querySelector('button').onclick=()=>d.remove()};
        const shadow=document.querySelector('#shadow').attachShadow({mode:'closed'});
        shadow.innerHTML='<button id="shadow-button">Shadow button</button>';
        shadow.querySelector('button').onclick=()=>report({kind:'shadow'});
        addEventListener('message',e=>{if(e.data?.fixture)report(e.data)});
        report({kind:'loaded'});</script>`,
      '/nested': `<!doctype html><meta charset="utf-8"><button id="nested-button">Nested action</button>
        <script>${report}document.querySelector('button').onclick=()=>report({kind:'nested'});report({kind:'nested-ready'});</script>`,
      '/next': `<!doctype html><meta charset="utf-8"><h1 id="destination">Navigation successful</h1>
        <script>${report}report({kind:'navigated',href:location.href});</script>`,
    };
    response.end(content[path] ?? 'Not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
