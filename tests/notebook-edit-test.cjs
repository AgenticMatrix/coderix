const fs = require('fs');
const nb = {
  cells: [
    {cell_type:'markdown',source:['# Test Notebook'],metadata:{}},
    {cell_type:'code',source:['print("hello")'],outputs:[],execution_count:null,metadata:{}},
    {cell_type:'code',source:['x = 1+2','print(x)'],outputs:[],execution_count:null,metadata:{}},
  ],
  metadata:{}, nbformat:4, nbformat_minor:5
};
fs.writeFileSync('C:/temp/test-nb.ipynb', JSON.stringify(nb));

const P = 'C:/temp/test-nb.ipynb';
let pass = 0, fail = 0;

async function main() {
  const mod = await import('../dist/tools/notebook-edit/executor.js');
  const opts = {cwd:'.',allowMutation:true,maxOutput:50000,bashTimeout:30000,agentSpawn:undefined};
  
  const tests = [];
  
  const r1 = await mod.execute({notebook_path:P,action:'list'}, opts);
  tests.push(['list', !r1.isError && r1.metadata?.cellCount===3]);
  
  const r2 = await mod.execute({notebook_path:P,action:'read',cell_index:1}, opts);
  tests.push(['read', r2.content?.includes('hello')]);
  
  const r3 = await mod.execute({notebook_path:P,action:'replace',cell_index:2,source:'y=99'}, opts);
  tests.push(['replace', !r3.isError]);
  
  const r4 = await mod.execute({notebook_path:P,action:'insert',cell_index:0,cell_type:'markdown',source:'# New'}, opts);
  tests.push(['insert', !r4.isError && r4.metadata?.cellIndex===0]);
  
  const r5 = await mod.execute({notebook_path:P,action:'delete',cell_index:0}, opts);
  tests.push(['delete', !r5.isError]);
  
  const r6 = await mod.execute({notebook_path:P,action:'list'}, opts);
  tests.push(['verify', r6.metadata?.cellCount===3]);
  
  const r7 = await mod.execute({}, opts);
  tests.push(['missing path', r7.isError]);
  
  const r8 = await mod.execute({notebook_path:'C:/temp/foo.txt',action:'list'}, opts);
  tests.push(['not ipynb', r8.isError]);
  
  const reg = await import('../dist/tools/registry.js');
  tests.push(['registered', !!reg.getAnthropicTools().find(t=>t.name==='notebook-edit')]);
  tests.push(['NOT in KNOWN', !!reg.getToolMeta('notebook-edit')]);

  for (const [name, ok] of tests) {
    console.log((ok?'PASS':'FAIL')+': '+name);
    ok?pass++:fail++;
  }
  console.log('\n'+pass+'/'+(pass+fail)+' passed');
  if (fail>0) process.exit(1);
}
main();
