async (page) => {
  const base = 'http://127.0.0.1:4174/';
  await page.setViewportSize({ width: 900, height: 1125 });
  for (const light of ['neutral', 'grazing']) {
    await page.goto(`${base}?capture=1&light=${light}`);
    await page.waitForFunction(() => window.__MODEL_READY__ === true);
    const stage = await page.evaluate(() => window.__MODEL_ROOT__.userData.buildPass);
    await page.evaluate(() => window.__CAPTURE_VIEW__('front'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: `workspaces/heart-reference-retry/output/playwright/${stage}/${light}.png`, scale: 'css' });
  }
  await page.goto(`${base}?capture=1`);
  await page.waitForFunction(() => window.__MODEL_READY__ === true);
}
