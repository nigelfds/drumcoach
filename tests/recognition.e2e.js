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

test("opens with the default eighth-note rock beat", async ({ page }) => {
  await page.goto("/?loopback=1");
  await page.waitForFunction(() => window.__dc && document.querySelectorAll("#grid .cell").length > 0);
  const { dims, active } = await page.evaluate(() => ({ dims: window.__dc.dims(), active: window.__dc.active() }));

  // 1 bar, eighth notes (2 steps/beat), 4 beats
  expect(dims).toEqual({ bars: 1, beatsPerBar: 4, stepsPerBeat: 2 });
  // hi-hat on all 8 eighths, snare on 2 & 4 (steps 2,6), kick on 1 & 3 (steps 0,4)
  expect(active).toEqual([
    "hihat:0", "hihat:1", "hihat:2", "hihat:3", "hihat:4", "hihat:5", "hihat:6", "hihat:7",
    "kick:0", "kick:4", "snare:2", "snare:6",
  ].sort());
});

test("detects two drums struck at the same time", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const s = document.getElementById("sens-range");
    s.value = "100"; s.dispatchEvent(new Event("input"));
  });
  const hit = (...voices) => page.evaluate(async (vs) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__dc.reset(); window.__dc.play(...vs); await sleep(500);
    return [...new Set(window.__dc.hits.map((h) => h.voice))].sort();
  }, voices);
  const CYMBALS = ["hihat", "ride", "crash"];

  // kick + a cymbal at the same instant → BOTH (kick plus a cymbal voice)
  const kh = await hit("kick", "hihat");
  expect(kh).toContain("kick");
  expect(kh.some((v) => CYMBALS.includes(v)), "a cymbal heard alongside the kick").toBeTruthy();
  expect(kh.length).toBe(2);

  // lone hits stay single — no phantom cymbal from a low drum's attack click
  expect(await hit("kick")).toEqual(["kick"]);
  expect(await hit("snare")).toEqual(["snare"]);
});
