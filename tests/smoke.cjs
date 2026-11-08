const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

const baseUrl = process.env.REPLAY_URL || "http://127.0.0.1:8765";
const browserPath =
  process.env.PLAYWRIGHT_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function seek(page, data, timestamp) {
  const offset = Math.max(0, Math.round(timestamp - data.timelineStart));
  await page.locator("#timeline").evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, offset);
  await page.waitForTimeout(120);
}

let browser;

(async () => {
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#replayShell").getAttribute("aria-busy") === "false");

  assert.equal(await page.locator("#groupSelect option").count(), 11, "expected 11 groups");
  assert.match(await page.locator("#dataNote").innerText(), /真实记录/);
  const verificationNote = await page.locator(".verification-note").innerText();
  assert.match(verificationNote, /未采集终端命令/);
  assert.match(verificationNote, /测试通过\/失败结果/);

  const selected = await page.evaluate(async () => {
    const index = await (await fetch("/data/index.json")).json();
    const group = index.groups.find((item) => item.id === document.querySelector("#groupSelect").value);
    const student = group.students.find((item) => item.id === document.querySelector("#studentSelect").value);
    return await (await fetch(`/${student.file}`)).json();
  });
  assert.ok(selected.code.length > 0, "default student should contain code events");
  assert.ok(selected.ai.length > 0, "default student should contain AI events");

  const firstPreview = selected.actions.find((item) => item.label === "Vis Result");
  assert.ok(firstPreview, "default student should contain a result preview event");
  await seek(page, selected, selected.timelineStart);
  assert.match(await page.locator("#previewStatus").innerText(), /尚未打开/);
  await seek(page, selected, firstPreview.t);
  assert.match(await page.locator("#previewStatus").innerText(), /已打开 1 次/);

  const firstCode = selected.code[0];
  await seek(page, selected, firstCode.t);
  const renderedCode = await page.locator("#codeView pre").allTextContents();
  assert.deepEqual(renderedCode, firstCode.code.replaceAll("\r\n", "\n").split("\n").map((line) => line || " "));
  assert.match(await page.locator("#codeMeta").innerText(), /快照 1\//);

  const firstAI = selected.ai[0];
  await seek(page, selected, firstAI.questionT);
  assert.equal(await page.locator(".message.user").count(), 1, "question should appear at send time");
  assert.equal(await page.locator(".message.ai").count(), 0, "reply must not appear before reply time");
  assert.equal(await page.locator(".waiting-reply").count(), 1, "waiting state should be visible");
  await seek(page, selected, firstAI.replyT);
  assert.equal(await page.locator(".message.ai").count(), 1, "reply should appear at reply time");

  const beforePlay = Number(await page.locator("#timeline").inputValue());
  await page.locator("#playButton").click();
  await page.waitForTimeout(350);
  const duringPlay = Number(await page.locator("#timeline").inputValue());
  assert.ok(duringPlay > beforePlay, "timeline should advance while playing");
  await page.locator("#playButton").click();
  const pausedAt = Number(await page.locator("#timeline").inputValue());
  await page.waitForTimeout(250);
  assert.equal(Number(await page.locator("#timeline").inputValue()), pausedAt, "timeline should stop while paused");

  const offline = selected.status.find((item) => item.status === "offline");
  assert.ok(offline, "default student should have an offline event");
  await seek(page, selected, offline.t);
  assert.equal(await page.locator("#replayShell").evaluate((node) => node.classList.contains("is-offline")), true);
  assert.equal(await page.locator("#offlineNotice").isVisible(), true);
  assert.match(await page.locator("#onlineStatus").innerText(), /离线记录/);

  const tabAction = selected.actions.find((item) => item.type === "tab-switch");
  assert.ok(tabAction, "default student should have a tab-switch event");
  await seek(page, selected, tabAction.t);
  assert.match(await page.locator("#tabStatus").innerText(), new RegExp(tabAction.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const middleCode = selected.code[Math.floor(selected.code.length / 2)];
  await seek(page, selected, middleCode.t);
  assert.ok((await page.locator("#codeView pre").count()) > 0, "middle replay state should render code");
  assert.ok((await page.locator(".activity-item").count()) > 0, "recent activity should render with code visible");
  const lowerPanelLayout = await page.evaluate(() => {
    const panel = document.querySelector(".lower-panel").getBoundingClientRect();
    const activity = document.querySelector("#activityList").getBoundingClientRect();
    const verification = document.querySelector(".verification-list").getBoundingClientRect();
    return { panelHeight: panel.height, activityHeight: activity.height, verificationHeight: verification.height };
  });
  assert.ok(lowerPanelLayout.panelHeight >= 150, "lower panel must keep its reserved height");
  assert.ok(lowerPanelLayout.activityHeight >= 100, "recent activity must remain visible");
  assert.ok(lowerPanelLayout.verificationHeight >= 70, "verification controls must remain visible");
  await page.screenshot({
    path: path.join(__dirname, "replay-desktop.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 900, height: 720 });
  await page.waitForTimeout(100);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    playVisible: Boolean(document.querySelector("#playButton")?.getBoundingClientRect().width),
    timelineVisible: Boolean(document.querySelector("#timeline")?.getBoundingClientRect().width),
  }));
  assert.ok(viewport.scrollWidth <= viewport.width, "narrow viewport must not have horizontal page overflow");
  assert.equal(viewport.playVisible, true);
  assert.equal(viewport.timelineVisible, true);
  await page.screenshot({ path: path.join(__dirname, "replay-narrow.png"), fullPage: true });

  assert.deepEqual(consoleErrors, [], `browser console errors: ${consoleErrors.join(" | ")}`);
  console.log(
    JSON.stringify(
      {
        groups: 11,
        selectedStudent: selected.displayName,
        codeSnapshots: selected.code.length,
        aiInteractions: selected.ai.length,
        playbackAdvancedMs: duringPlay - beforePlay,
        offlineVerified: true,
        tabSwitchVerified: tabAction.label,
        screenshot: path.join(__dirname, "replay-desktop.png"),
        narrowScreenshot: path.join(__dirname, "replay-narrow.png"),
      },
      null,
      2,
    ),
  );
  await browser.close();
  browser = null;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
});
