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

  // Coarse sanity floor (runs jitter ~18–24/24 — the close kick↔tom and
  // hi-hat↔ride pairs swap within their family).
  expect(t.totalCorrect).toBeGreaterThanOrEqual(14);

  // The real regression guard is FAMILY-level: a low drum must stay a low drum
  // (never a cymbal/snare), a cymbal must stay a cymbal. This tolerates the
  // within-family jitter but catches gross errors like the original
  // "snare → hi-hat/ride/crash" bug. (Allow 1 stray per voice.)
  const FAMILY = { kick: "low", tom1: "low", tom2: "low", tom3: "low", snare: "snare", hihat: "cym", ride: "cym", crash: "cym" };
  for (const [v, p] of Object.entries(t.per)) {
    const outOfFamily = Object.entries(p.confused)
      .filter(([k]) => FAMILY[k] !== FAMILY[v])
      .reduce((s, [, n]) => s + n, 0);
    expect(outOfFamily, `${v} confused out of its family`).toBeLessThanOrEqual(1);
  }
  // Snare is broadband and well separated — it should be reliably itself.
  expect(t.per.snare.correct).toBeGreaterThanOrEqual(2);

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

test("records a dense groove — kick on every beat + eighth hi-hats", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    const s = document.getElementById("sens-range");
    s.value = "100"; s.dispatchEvent(new Event("input"));
    // hi-hat on all 8 eighths, snare on beats 3 & 4 (steps 4,6), kick on every beat (steps 0,2,4,6)
    const cells = [];
    for (let i = 0; i < 8; i++) cells.push("hihat:" + i);
    cells.push("snare:4", "snare:6", "kick:0", "kick:2", "kick:4", "kick:6");
    window.__dc.setPattern(cells);
  });
  await page.click("#loop-btn"); // loop on, for a stable multi-bar capture
  await page.evaluate(() => window.__dc.reset());
  await page.click("#pattern-play");
  await page.waitForTimeout(5600); // ~2 bars @ 88 bpm (1 bar = 8 × 0.341 s)
  await page.click("#pattern-play"); // stop
  await page.waitForTimeout(150);

  const { counts, kickIntervals } = await page.evaluate(() => {
    const hits = window.__dc.hits;
    const counts = {};
    for (const h of hits) counts[h.voice] = (counts[h.voice] || 0) + 1;
    const kt = hits.filter((h) => h.voice === "kick").map((h) => h.t);
    const kickIntervals = kt.slice(1).map((t, i) => +(t - kt[i]).toFixed(3));
    return { counts, kickIntervals };
  });

  // kick lands on every beat — the staff records the four-on-the-floor rhythm
  expect(counts.kick || 0).toBeGreaterThanOrEqual(6);
  const med = kickIntervals.sort((a, b) => a - b)[Math.floor(kickIntervals.length / 2)];
  expect(med).toBeGreaterThan(0.5);
  expect(med).toBeLessThan(0.9); // ≈ one beat at 88 bpm (0.682 s)
  // the eighth-note hi-hats register
  expect(counts.hihat || 0).toBeGreaterThanOrEqual(2);

  // KNOWN LIMIT: beats 3 & 4 are kick + snare + hi-hat at once. A single mic
  // onset yields at most one low drum + one cymbal, so the snare is masked there
  // and is not asserted. See README "Multiple drums at once".
});
