const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const stage = process.argv[2] || 'ui';
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid UI evidence stage');
  const output = path.join(__dirname, 'output', stage);
  if (fs.existsSync(path.join(output, 'geometry.json'))) throw new Error('UI output must not overwrite a model capture stage');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, status: 'running', startedAt: new Date().toISOString() }));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const checks = [], errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto('http://127.0.0.1:4175/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__MODEL_READY__ === true);
    assert(await page.locator('.reference-card img').evaluate(img => img.complete && img.naturalWidth === 1254));
    checks.push('supplied reference sheet loaded');
    for (const [view, label] of [['front','前面'],['left','解剖左侧'],['rear','后面'],['right','解剖右侧']]) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.click();
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      checks.push(`${view} button`);
    }
    await page.getByRole('button', { name: '前面', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('button', { name: '前面', exact: true }).getAttribute('aria-pressed'), 'true');
    checks.push('keyboard view selection');
    const transforms = () => page.evaluate(() => Object.entries(window.__MODEL_ROOT__.userData.sculptRuntime.nodes).map(([id,n]) => [id,n.position.toArray()]));
    const before = await transforms();
    await page.getByRole('button', { name: '分解部件', exact: true }).click();
    assert.notDeepEqual(await transforms(), before);
    await page.screenshot({ path: path.join(output, 'exploded.png') });
    await page.getByRole('button', { name: '恢复装配', exact: true }).click();
    assert.deepEqual(await transforms(), before);
    checks.push('explode moves groups and restore returns exact transforms');
    await page.getByRole('button', { name: '自动旋转', exact: true }).click();
    assert.equal(await page.locator('#turntable').getAttribute('aria-pressed'), 'true');
    await page.locator('#reset').click();
    assert.equal(await page.locator('#turntable').getAttribute('aria-pressed'), 'false');
    checks.push('autorotate and reset');
    await page.locator('#scene').click({ position: { x: 540, y: 580 } });
    assert.notEqual(await page.locator('#part-label').textContent(), '单击部件查看名称');
    checks.push('actual canvas click selects a named part');
    assert.equal(await page.evaluate(() => window.__SELECT_PART__('left-atrium')), true);
    assert.equal(await page.locator('#part-label').textContent(), '左心房');
    checks.push('posterior atrium semantic selection');
    await page.locator('#scene').click({ position: { x: 10, y: 700 } });
    await page.screenshot({ path: path.join(output, 'desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(output, 'mobile.png') });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const button of await page.locator('button').all()) {
      const box = await button.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= 391 && box.y >= 0 && box.y + box.height <= 845);
    }
    checks.push('390x844 viewport has visible controls and no horizontal overflow');
    assert.equal(errors.length, 0, errors.join('\n'));
    checks.push('no runtime console or HTTP errors');
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
    console.log(JSON.stringify({ passed: true, checks: checks.length, errors }));
  } catch (error) {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: false, checks, errors, failure: String(error) }, null, 2));
    throw error;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
