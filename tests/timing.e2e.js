import { test, expect } from "@playwright/test";

// Timing-feedback features: the difficulty selector (which scales the scoring
// windows and persists) and the latency offset measured during the built-in-kit
// calibration. Driven through the loopback audio path.

async function boot(page) {
  await page.goto("/?loopback=1");
  await page.waitForFunction(() => window.__dc && document.querySelectorAll("#grid .cell").length > 0);
  await page.evaluate(() => {
    document.getElementById("overlay").hidden = true;
    document.getElementById("settings").open = true;
  });
}

test("difficulty selector scales the scoring windows and persists", async ({ page }) => {
  await boot(page); // fresh, isolated storage per test

  // defaults to Beginner — the most forgiving windows
  expect(await page.evaluate(() => window.__dc.difficulty())).toBe("beginner");
  const beg = await page.evaluate(() => window.__dc.windows());
  expect(beg.clean).toBeCloseTo(0.070, 3);
  expect(beg.match).toBeCloseTo(0.150, 3);

  // switching to Pro tightens every window
  await page.click('#difficulty .seg[data-level="pro"]');
  const pro = await page.evaluate(() => window.__dc.windows());
  expect(pro.clean).toBeLessThan(beg.clean);
  expect(pro.match).toBeLessThan(beg.match);
  expect(pro.perfect).toBeLessThan(beg.perfect);
  await expect(page.locator('#difficulty .seg[data-level="pro"]')).toHaveClass(/on/);

  // and the choice survives a reload
  await page.reload();
  await page.waitForFunction(() => window.__dc);
  expect(await page.evaluate(() => window.__dc.difficulty())).toBe("pro");
});

test("calibrating to the built-in kit measures a timing-latency offset", async ({ page }) => {
  await boot(page);
  await page.click("#mic-btn");
  await page.waitForTimeout(300);

  // no latency known until calibration runs
  expect(await page.evaluate(() => window.__dc.latency())).toBe(0);

  await page.click("#auto-cal");
  // the auto-cal plays all 8 voices; wait for it to finish and write a result
  await page.waitForFunction(
    () => /Done — calibrated/.test(document.getElementById("cal-status").textContent),
    null,
    { timeout: 45_000 }
  );

  const offset = await page.evaluate(() => window.__dc.latency());
  // a real, positive pipeline delay was measured and stored, within sane bounds
  expect(offset).toBeGreaterThan(0);
  expect(offset).toBeLessThan(0.4);
  await expect(page.locator("#latency-readout")).toContainText("ms");
});
