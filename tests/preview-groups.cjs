const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const baseUrl = process.env.REPLAY_URL || "http://127.0.0.1:8765";
const browserPath = process.env.PLAYWRIGHT_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function hasVisual(spec) {
  return Boolean(spec.mark || spec.layer || spec.hconcat || spec.vconcat || spec.concat || spec.repeat || spec.facet);
}

async function seek(page, data, timestamp) {
  const offset = Math.max(0, Math.round(timestamp - data.timelineStart));
  await page.locator("#timeline").evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, offset);
}

let browser;
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#replayShell")?.getAttribute("aria-busy") === "false");
  const index = await page.evaluate(async () => await (await fetch("/data/index.json")).json());
  const results = [];

  for (const meta of index.groups) {
    await page.selectOption("#groupSelect", meta.id);
    await page.waitForFunction(() => document.querySelector("#replayShell")?.getAttribute("aria-busy") === "false");
    const data = await page.evaluate(async (file) => await (await fetch(`/${file}`)).json(), meta.file);
    const snapshot = [...data.code].reverse().find((item) => {
      try { return hasVisual(JSON.parse(item.code)); } catch { return false; }
    });
    if (!snapshot) {
      results.push({ group: meta.id, status: "no-renderable-snapshot" });
      continue;
    }

    await seek(page, data, snapshot.t);
    await page.waitForFunction(() => ["已同步", "生成失败"].includes(document.querySelector("#previewState")?.textContent), null, { timeout: 15000 });
    if (await page.locator("#previewState").innerText() !== "已同步") {
      results.push({ group: meta.id, status: "render-error", message: await page.locator("#previewMessage").innerText() });
      continue;
    }
    if (await page.locator("#previewToggle").getAttribute("aria-pressed") !== "true") {
      await page.locator("#previewToggle").click();
    }
    await page.waitForTimeout(120);
    const measurement = await page.evaluate(() => {
      const stage = document.querySelector("#previewStage").getBoundingClientRect();
      const svg = document.querySelector("#visualization svg").getBoundingClientRect();
      const visualization = document.querySelector("#visualization");
      return {
        natural: visualization.dataset.naturalSize,
        scale: Number(visualization.dataset.fitScale),
        rendered: `${Math.round(svg.width)}x${Math.round(svg.height)}`,
        widthRatio: Number((svg.width / stage.width).toFixed(3)),
        codeVisible: getComputedStyle(document.querySelector("#codePanel")).display !== "none",
        scrollable: svg.width > stage.width || svg.height > stage.height,
      };
    });
    assert.equal(measurement.codeVisible, true, `${meta.id} should retain its code editor`);
    assert.ok(measurement.scale >= 0.45, `${meta.id} should not open at an unreadably small scale`);
    results.push({ group: meta.id, status: "ok", ...measurement });
    await page.locator("#previewToggle").click();
  }

  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  browser = null;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
