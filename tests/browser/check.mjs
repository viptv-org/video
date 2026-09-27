import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../../tv-web/package.json', import.meta.url));
const { chromium, firefox, webkit } = require('@playwright/test');
const url = process.env.MEDIA_TEST_URL || 'https://viptv.local.test:18790/tests/browser/index.html';
const names = (process.env.MEDIA_TEST_BROWSERS || 'chromium,firefox,webkit').split(',');
const results = [];
for (const name of names) {
  let browser;
  try {
    browser = await ({chromium,firefox,webkit}[name]).launch({headless:true});
    const page = await browser.newPage();
    page.setDefaultTimeout(25000);
    const errors=[];page.on('pageerror', e => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => !!window.mediaTest);
    const webcodecs=await page.evaluate(()=>typeof VideoDecoder==='function'&&typeof AudioDecoder==='function');
    for(const engine of webcodecs?['mse','bunny','auto']:['mse','auto']) {
      for(const file of ['h264-aac.mkv','long-gop.mkv','multi-audio.mkv']) {
        const start=Date.now();
        try {
          await page.evaluate(({file,engine})=>window.mediaTest.open(file,engine),{file,engine});
          await page.waitForFunction(()=>window.mediaTest.snapshot?.time.positionSeconds>0.3);
          await page.evaluate(()=>window.mediaTest.pause());
          await page.evaluate(()=>window.mediaTest.seek(7));
          const paused=await page.evaluate(()=>window.mediaTest.snapshot);
          if(Math.abs(paused.time.positionSeconds-7)>0.08)throw Error(`Paused seek outside 80ms: ${paused.time.positionSeconds}`);
          if(file==='multi-audio.mkv') {
            const id=paused.tracks.audio.find(t=>t.language==='spa')?.id;
            if(!id)throw Error('Spanish audio missing');
            await page.evaluate(id=>window.mediaTest.audio(id),id);
            const switched=await page.evaluate(()=>window.mediaTest.snapshot);
            if(switched.tracks.selectedAudioId!==id)throw Error('Audio selection lost');
          }
          await page.evaluate(()=>window.mediaTest.play());
          await page.waitForFunction(()=>window.mediaTest.snapshot?.time.positionSeconds>7.4);
          const snapshot=await page.evaluate(()=>window.mediaTest.snapshot);
          await page.evaluate(()=>window.mediaTest.dispose());
          await page.waitForTimeout(100);
          const final=await page.evaluate(()=>window.mediaTest.snapshot);
          if(final.state!=='disposed')throw Error('Disposed session was revived');
          results.push({browser:name,engine,file,passed:true,elapsedMs:Date.now()-start,diagnostics:snapshot.diagnostics,webcodecs});
        }catch(error){results.push({browser:name,engine,file,passed:false,error:String(error),events:await page.evaluate(()=>window.mediaTest.events)});await page.evaluate(()=>window.mediaTest.dispose()).catch(()=>{});}
      }
    }
    if(errors.length)results.push({browser:name,passed:false,pageErrors:errors});
  }catch(error){results.push({browser:name,passed:false,launchError:String(error)});}
  finally{await browser?.close();}
  console.log(JSON.stringify(results.filter(r=>r.browser===name),null,2));
}
writeFileSync(process.env.MEDIA_TEST_REPORT||'/tmp/viptv-browser-matrix.json',JSON.stringify(results,null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
