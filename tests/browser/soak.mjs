import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../../../tv-web/package.json', import.meta.url));
const name = process.env.MEDIA_BROWSER || 'chromium';
const browser = await require('@playwright/test')[name].launch({ headless: true });
const result = { browser: name, samples: [], passed: false };
const page = await browser.newPage();
try {
  await page.goto(process.env.MEDIA_TEST_URL);
  await page.waitForFunction(() => window.mediaTest);
  await page.mouse.click(20, 20);
  await page.evaluate(() => window.mediaTest.open('soak.mkv', 'auto'));
  await page.waitForFunction(() => window.mediaTest.snapshot.time.positionSeconds > 1);
  const end = Date.now() + 30 * 60 * 1000;
  while (Date.now() < end) {
    await page.waitForTimeout(15000);
    const snapshot = await page.evaluate(() => window.mediaTest.snapshot);
    result.samples.push({ at: Date.now(), state: snapshot.state, time: snapshot.time, diagnostics: snapshot.diagnostics });
    writeFileSync(process.env.MEDIA_TEST_REPORT, JSON.stringify(result, null, 2));
    if (['error', 'ended'].includes(snapshot.state)) throw Error(`Unexpected ${snapshot.state}`);
    console.log(name, Math.round(snapshot.time.positionSeconds), snapshot.state, snapshot.diagnostics?.droppedFrames);
  }
  const diagnostics = result.samples.at(-1).diagnostics;
  result.droppedRatio = (diagnostics?.droppedFrames || 0) / Math.max(1, (diagnostics?.presentedFrames || 0) + (diagnostics?.droppedFrames || 0));
  result.avMeasured = result.samples.every(s => Number.isFinite(s.diagnostics?.estimatedAvSkewMs));
  result.passed = result.droppedRatio < .01 && result.samples.every(s => s.state === 'playing') && result.samples.every(s => (s.diagnostics?.estimatedAvSkewMs ?? 0) <= 80);
} catch (error) { result.error = String(error); }
finally {
  await page.evaluate(() => window.mediaTest.dispose()).catch(() => {});
  await browser.close();
  writeFileSync(process.env.MEDIA_TEST_REPORT, JSON.stringify(result, null, 2));
  console.log('SOAK_RESULT', name, result.passed, result.error || '');
}
process.exit(result.passed ? 0 : 1);
