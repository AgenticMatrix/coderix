/**
 * Web-bridge feature test — exercises all new actions via CDP directly.
 * Run: node tests/web-bridge-test.js
 */

const CDP = require('chrome-remote-interface');
const fs = require('fs');

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    process.stdout.write(`  ${name} ... `);
    const r = await fn();
    console.log(`PASS`);
    passed++;
    return r;
  } catch(e) {
    console.log(`FAIL: ${e.message}`);
    failed++;
  }
}

async function main() {
  console.log('Connecting to Chrome on port 9222...');
  const client = await CDP({host:'localhost', port:9222});
  await client.Page.enable();
  await client.Runtime.enable();
  await client.DOM.enable();
  console.log('Connected.\n');

  // Navigate to test page
  console.log('--- Navigating ---');
  await client.Page.navigate({url:'file:///C:/temp/web-bridge-test.html'});
  await new Promise(r=>setTimeout(r,1000));
  const title = await client.Runtime.evaluate({expression:'document.title', returnByValue:true});
  console.log(`  Page title: "${title.result.value}"\n`);

  // 1. snapshot
  await test('1. snapshot (AX tree)', async () => {
    const r = await client.Accessibility.getFullAXTree({});
    const interactive = r.nodes.filter(n => {
      const role = n.role?.value;
      return role && ['textbox','button','checkbox','link','combobox'].includes(role);
    });
    return { nodes: r.nodes.length, interactiveCount: interactive.length };
  });

  // 2. fill
  await test('2. fill (native setter)', async () => {
    const v = await client.Runtime.evaluate({
      expression: `(function(){
        const t=document.querySelector('#name');
        const ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
        ns.call(t,'John Doe');
        t.dispatchEvent(new Event('input',{bubbles:true}));
        t.dispatchEvent(new Event('change',{bubbles:true}));
        return t.value;
      })()`,
      returnByValue: true,
    });
    return { value: v.result.value };
  });

  // 3. type
  await test('3. type (insertText)', async () => {
    await client.Runtime.evaluate({expression:"document.querySelector('#email').focus()", returnByValue:true});
    await client.Input.insertText({text:'test@example.com'});
    const v = await client.Runtime.evaluate({expression:"document.querySelector('#email').value", returnByValue:true});
    return { value: v.result.value };
  });

  // 4. send_keys
  await test('4. send_keys (Tab key)', async () => {
    await client.Runtime.evaluate({expression:"document.querySelector('#name').focus()", returnByValue:true});
    await client.Input.dispatchKeyEvent({type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9});
    await client.Input.dispatchKeyEvent({type:'keyUp', key:'Tab', code:'Tab', windowsVirtualKeyCode:9});
    const focused = await client.Runtime.evaluate({
      expression:'document.activeElement ? document.activeElement.id || document.activeElement.tagName : "none"',
      returnByValue:true,
    });
    return { focused: focused.result.value };
  });

  // 5. click
  await test('5. click (CSS selector)', async () => {
    await client.Runtime.evaluate({expression:"document.querySelector('#name').value='TestName'", returnByValue:true});
    await client.Runtime.evaluate({
      expression: "document.querySelector('#submit-btn').click()",
      returnByValue: true,
    });
    await new Promise(r=>setTimeout(r,200));
    const r = await client.Runtime.evaluate({expression:"document.querySelector('#result').textContent", returnByValue:true});
    return { result: r.result.value };
  });

  // 6. mouse_click
  await test('6. mouse_click (coordinates)', async () => {
    const objId = await client.Runtime.evaluate({expression:'document.querySelector("#reset-btn")', returnByValue:false});
    const box = await client.DOM.getBoxModel({objectId:objId.result.objectId});
    const q = box.model.content;
    const cx = (q[0]+q[2]+q[4]+q[6])/4, cy = (q[1]+q[3]+q[5]+q[7])/4;
    await client.Input.dispatchMouseEvent({type:'mouseMoved', x:cx, y:cy, button:'none', buttons:0});
    await client.Input.dispatchMouseEvent({type:'mousePressed', x:cx, y:cy, button:'left', buttons:1, clickCount:1});
    await client.Input.dispatchMouseEvent({type:'mouseReleased', x:cx, y:cy, button:'left', buttons:0, clickCount:1});
    await new Promise(r=>setTimeout(r,200));
    const result = await client.Runtime.evaluate({expression:"document.querySelector('#result').textContent", returnByValue:true});
    return { x:Math.round(cx), y:Math.round(cy), cleared: result.result.value === '' };
  });

  // 7. screenshot
  await test('7. screenshot', async () => {
    const r = await client.Page.captureScreenshot({format:'png'});
    fs.writeFileSync('/tmp/test-screenshot.png', Buffer.from(r.data,'base64'));
    return { size: r.data.length, file:'/tmp/test-screenshot.png' };
  });

  // 8. element screenshot
  await test('8. screenshot (element clip)', async () => {
    const objId = await client.Runtime.evaluate({expression:'document.querySelector("h1")', returnByValue:false});
    const box = await client.DOM.getBoxModel({objectId:objId.result.objectId});
    const q = box.model.border;
    const xs = [q[0],q[2],q[4],q[6]], ys = [q[1],q[3],q[5],q[7]];
    const x = Math.min(...xs), y = Math.min(...ys);
    const r = await client.Page.captureScreenshot({
      format:'png',
      clip:{x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y,scale:1}
    });
    return { element:'h1', size: r.data.length };
  });

  // 9. evaluate
  await test('9. evaluate', async () => {
    const r = await client.Runtime.evaluate({
      expression: 'document.title + " | " + document.querySelectorAll("a").length + " links"',
      returnByValue: true,
    });
    return { result: r.result.value };
  });

  // 10. extract
  await test('10. extract', async () => {
    const r = await client.Runtime.evaluate({expression:'document.body.innerText', returnByValue:true});
    const text = r.result.value || '';
    return { length: text.length, preview: text.slice(0,60).replace(/\n/g,' ') };
  });

  // 11. scroll
  await test('11. scroll', async () => {
    const before = await client.Runtime.evaluate({expression:'window.scrollY', returnByValue:true});
    await client.Runtime.evaluate({expression:'window.scrollBy({top:800,behavior:"instant"})'});
    const after = await client.Runtime.evaluate({expression:'window.scrollY', returnByValue:true});
    return { before: before.result.value, after: after.result.value };
  });

  // 12. cdp raw
  await test('12. cdp (raw passthrough)', async () => {
    const r = await client.send('Runtime.evaluate', {expression:'[1,2,3].map(x=>x*2)', returnByValue:true});
    return { method:'Runtime.evaluate', result: r.result.value };
  });

  // 13. upload
  await test('13. upload (setFileInputFiles)', async () => {
    fs.writeFileSync('/tmp/test-upload.txt', 'hello world');
    const doc = await client.DOM.getDocument();
    const node = await client.DOM.querySelector({nodeId:doc.root.nodeId, selector:'#file-input'});
    await client.DOM.setFileInputFiles({files:['C:/temp/test-upload.txt'], nodeId:node.nodeId});
    const v = await client.Runtime.evaluate({expression:"document.querySelector('#file-input').files.length", returnByValue:true});
    return { fileCount: v.result.value };
  });

  // 14. save_as_pdf
  await test('14. save_as_pdf', async () => {
    const r = await client.Page.printToPDF({
      printBackground:true, landscape:false, scale:1,
      paperWidth:8.27, paperHeight:11.69, preferCSSPageSize:true,
    });
    fs.writeFileSync('/tmp/test-output.pdf', Buffer.from(r.data,'base64'));
    return { mimeType:'application/pdf', size: r.data.length };
  });

  // 15. fill contenteditable
  await test('15. fill (contenteditable)', async () => {
    const v = JSON.stringify('Edited content!');
    const r = await client.Runtime.evaluate({
      expression: `(function(){
        const t=document.querySelector('#content-area');
        t.focus();
        t.textContent=${v};
        t.dispatchEvent(new InputEvent('input',{inputType:'insertText',data:${v},bubbles:true}));
        return t.textContent;
      })()`,
      returnByValue: true,
    });
    return { content: r.result.value };
  });

  await client.close();

  console.log(`\n====================`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed+failed} total`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
