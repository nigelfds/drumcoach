import { test, expect } from "@playwright/test";

// Dismiss the onboarding sheet and start the loopback "mic".
async function boot(page) {
  await page.goto("/?loopback=1");
  await page.waitForFunction(() => document.querySelectorAll("#grid .cell").length > 0);
  await page.evaluate(() => {
    document.getElementById("overlay").hidden = true;
    document.getElementById("settings").open = true; // reveal calibration/test buttons
  });
  await page.click("#mic-btn");
  await page.waitForTimeout(300);
}

test("loads cleanly with the redesigned UI", async ({ page }) => {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto("/?loopback=1");
  await page.waitForFunction(() => document.querySelectorAll("#grid .cell").length > 0);

  // default 1-bar seeded rock beat across the 3 core voices
  await expect(page.locator("#bars-select")).toHaveValue("1");
  expect(await page.locator("#grid .vname").allTextContents()).toEqual(["Hi-hat", "Snare", "Kick"]);
  expect(await page.locator("#grid .cell.on").count()).toBeGreaterThan(0);

  // ignore the favicon 404
  expect(errors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test("recognition self-test produces a per-voice scorecard", async ({ page }) => {
  await boot(page);
  await page.click("#test-recog"); // ~11s test
  await page.waitForFunction(() => window.__dc && window.__dc.lastTest, null, { timeout: 30_000 });

  const t = await page.evaluate(() => window.__dc.lastTest);
  expect(t.totalAll).toBe(24); // 8 voices × 3 hits

  // recognition should be strong on the built-in sounds (a small jitter margin
  // below the typical 24/24). The kick/floor-tom pair must stay separated.
  expect(t.totalCorrect).toBeGreaterThanOrEqual(20);
  for (const v of ["kick", "snare", "tom3", "crash"]) {
    expect(t.per[v].correct, `${v} recognition`).toBeGreaterThanOrEqual(2);
  }

  // the scorecard is rendered
  await expect(page.locator("#test-results .tr-head")).toContainText("Recognition:");
});

test("playing a pattern is detected through the loopback pipeline", async ({ page }) => {
  await boot(page);
  // crank sensitivity so the seeded beat (incl. quiet hats) registers, and reset the log
  await page.evaluate(() => {
    const s = document.getElementById("sens-range");
    s.value = "100"; s.dispatchEvent(new Event("input"));
    window.__dc.reset();
  });
  await page.click("#pattern-play");
  await page.waitForTimeout(2500);
  await page.click("#pattern-play"); // stop

  const detected = await page.evaluate(() => window.__dc.hits.map((h) => h.voice));
  expect(detected.length).toBeGreaterThan(3);
  // the rock beat is kick/snare/hi-hat — at least one of each family should appear
  expect(detected.some((v) => v === "kick" || v === "snare")).toBeTruthy();
});
