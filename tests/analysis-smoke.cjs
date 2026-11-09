const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

const baseUrl = process.env.REPLAY_URL || "http://127.0.0.1:8765";
const browserPath = process.env.PLAYWRIGHT_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

let browser;
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${baseUrl}/app/analysis.html?group=zju-1`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#analysisMain")?.getAttribute("aria-busy") === "false");
  assert.equal(await page.locator("#groupSelect option").count(), 11, "analysis should expose 11 groups");
  assert.equal(await page.locator("#groupSelect").inputValue(), "zju-1");
  assert.equal(await page.locator(".overview-metrics .metric").count(), 6);
  assert.equal(await page.locator(".member-chip").count(), 3);
  assert.ok((await page.locator(".participation-row").count()) >= 3);
  assert.ok((await page.locator(".behavior-segment").count()) > 0);
  assert.equal(await page.locator(".icap-window").count(), 28, "zju-1 should expose all ICAP windows");
  assert.ok((await page.locator(".anomaly-item").count()) > 0);
  assert.equal(await page.locator("#aiAnalysisList .analysis-entry").count(), 1, "zju-1 has one unique AI interaction analysis");
  assert.ok((await page.locator("#codeAnalysisView .milestone").count()) > 0);
  assert.ok((await page.locator("#noteAnalysisView .insight-row").count()) > 0);
  assert.equal(await page.locator("#classTableBody tr").count(), 11);

  const firstDetail = await page.locator("#icapDetail").innerText();
  await page.locator(".icap-window").nth(1).click();
  const secondDetail = await page.locator("#icapDetail").innerText();
  assert.notEqual(secondDetail, firstDetail, "selecting an ICAP window should update detail");

  await page.screenshot({ path: path.join(__dirname, "analysis-desktop.png"), fullPage: true });
  await page.selectOption("#groupSelect", "zju-6");
  await page.waitForFunction(() => document.querySelector("#analysisMain")?.getAttribute("aria-busy") === "false");
  assert.match(await page.locator("#aiAnalysisList").innerText(), /没有可用的AI交互分析/);
  assert.match(await page.locator("#noteAnalysisView").innerText(), /没有笔记分析记录/);
  assert.match(await page.locator("#replayLink").getAttribute("href"), /\/app\/index\.html\?group=zju-6/);

  await page.setViewportSize({ width: 900, height: 720 });
  await page.selectOption("#groupSelect", "zju-8");
  await page.waitForFunction(() => document.querySelector("#analysisMain")?.getAttribute("aria-busy") === "false");
  const narrow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(narrow.scrollWidth <= narrow.width, "analysis should not overflow the narrow viewport");
  await page.screenshot({ path: path.join(__dirname, "analysis-narrow.png"), fullPage: true });

  await page.locator("#replayLink").click();
  await page.waitForURL(/\/app\/index\.html\?group=zju-8$/);
  await page.waitForFunction(() => document.querySelector("#replayShell")?.getAttribute("aria-busy") === "false");
  assert.equal(await page.locator("#groupSelect").inputValue(), "zju-8", "return button should open replay for the same group");

  assert.deepEqual(errors, [], `browser errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({
    groups: 11,
    zju1IcapWindows: 28,
    zju1AiInteractions: 1,
    desktopScreenshot: path.join(__dirname, "analysis-desktop.png"),
    narrowScreenshot: path.join(__dirname, "analysis-narrow.png"),
  }, null, 2));
  await browser.close();
  browser = null;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
