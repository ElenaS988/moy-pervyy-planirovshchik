// Development-only static preview. Runtime deliverable remains three files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
function serve(port = 4173) {
  const root=path.resolve(__dirname,'..');
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost');
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    if(!['index.html','style.css','script.js'].includes(file)){res.writeHead(404);res.end('Not found');return;}
    res.setHeader('Content-Type',{'index.html':'text/html; charset=utf-8','style.css':'text/css; charset=utf-8','script.js':'text/javascript; charset=utf-8'}[file]);
    res.setHeader('Cache-Control','no-store');
    fs.readFile(path.join(root,file),(err,body)=>{if(err){res.writeHead(500);res.end('Read error');}else res.end(body);});
  });
  return new Promise((resolve,reject)=>{server.on('error',reject);server.listen(port,'127.0.0.1',()=>resolve(server));});
}
module.exports={serve};
if(require.main===module)serve(Number(process.env.PORT||4173)).then(server=>{console.log(`Local: http://127.0.0.1:${server.address().port}`);process.on('SIGINT',()=>server.close(()=>process.exit(0)));}).catch(e=>{console.error(e.message);process.exit(1);});
