import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(process.env.MEDIA_PLAYWRIGHT_PACKAGE || new URL('../../../tv-web/package.json', import.meta.url));
const { chromium, firefox, webkit } = require('@playwright/test');
const browsers = { chromium, firefox, webkit };
const results = [];
for (const name of (process.env.MEDIA_TEST_BROWSERS || 'chromium,firefox,webkit').split(',')) {
  let browser,page;
  let stage='launch';
  try {
    browser = await browsers[name].launch({headless:true,...(name==='webkit'&&process.env.MEDIA_WEBKIT_EXECUTABLE ? {executablePath:process.env.MEDIA_WEBKIT_EXECUTABLE}: {})});
    page=await browser.newPage({ignoreHTTPSErrors:true});page.setDefaultTimeout(15000);
    for(const sparse of [false,true]) {
      await page.goto(process.env.MEDIA_TEST_URL || 'https://localhost:18795/tests/browser/index.html');
      await page.waitForFunction(()=>!!window.mediaTest);
      if(sparse)await page.evaluate(()=>document.querySelector('video').addEventListener('timeupdate',event=>event.stopImmediatePropagation(),true));
      stage='open';
      await page.evaluate(engine=>window.mediaTest.open('index.m3u8',engine),sparse?'native-sparse':'native');
      const stages=[];
      const advance=async (position,frames) => {
        await page.waitForFunction(({position,frames})=>{
          const api=window.mediaTest,s=api.snapshot,m=api.media();
          return s.state==='playing'&&s.time.positionSeconds>position&&m.outputFrames>frames&&
            (s.diagnostics?.presentedPositionSeconds===undefined||s.diagnostics.presentedPositionSeconds>position);
        },{position,frames});
        const value=await page.evaluate(()=>({snapshot:window.mediaTest.snapshot,media:window.mediaTest.media()}));
        if(Math.abs(value.snapshot.time.positionSeconds-value.media.position)>.4)throw Error('Published clock diverged from media clock');
        stages.push(value);return value;
      };
      stage='first-frame';const first=await advance(.4,0);
      stage='second-frame';const second=await advance(first.media.position+.8,first.media.outputFrames);
      stage='pause';await page.evaluate(()=>window.mediaTest.pause());
      const paused=await page.evaluate(()=>({snapshot:window.mediaTest.snapshot,media:window.mediaTest.media()}));
      await page.waitForTimeout(350);
      const held=await page.evaluate(()=>window.mediaTest.media());
      if(!paused.media.paused||Math.abs(held.position-paused.media.position)>.08)throw Error('Pause did not hold the media clock');
      if(Math.abs(paused.snapshot.time.positionSeconds-paused.media.position)>.08)throw Error('Pause published a stale position');
      stage='seek';await page.evaluate(()=>window.mediaTest.seek(3));
      await page.waitForFunction(()=>Math.abs(window.mediaTest.media().position-3)<.08);
      const seek=await page.evaluate(()=>window.mediaTest.snapshot);
      if(seek.state!=='paused'||Math.abs(seek.time.positionSeconds-3)>.08)throw Error('Manual paused seek lost position or intent');
      stage='resume';await page.evaluate(()=>window.mediaTest.play());
      await advance(3.2,second.media.outputFrames);
      for(const position of [1,2]){
        stage='replacement';await page.evaluate(position=>window.mediaTest.replace('index.m3u8',position),position);
        await advance(position+.2,0);
      }
      await page.evaluate(()=>window.mediaTest.dispose());
      await page.waitForTimeout(350);
      if(await page.evaluate(()=>window.mediaTest.snapshot.state)!=='disposed')throw Error('Retired callbacks revived a disposed session');
      results.push({browser:name,sparseEvents:sparse,passed:true,stages:stages.map(({snapshot,media})=>({state:snapshot.state,time:snapshot.time,diagnostics:snapshot.diagnostics,media,presentationEvidence:snapshot.diagnostics?.presentedPositionSeconds===undefined?'playback-quality':'frame-callback'}))});
    }
  }catch(error){results.push({browser:name,passed:false,stage,error:String(error),observation:await page?.evaluate(()=>({snapshot:window.mediaTest?.snapshot,media:window.mediaTest?.media()})).catch(()=>undefined)});}
  finally{await browser?.close();}
}
writeFileSync(process.env.MEDIA_TEST_REPORT || '/tmp/ps4-html-controls.json',JSON.stringify(results,null,2));
console.log(JSON.stringify(results.map(({stages,...result})=>result),null,2));
if(results.some(result=>!result.passed))process.exitCode=1;
