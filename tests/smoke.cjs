const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");

const baseUrl = process.env.REPLAY_URL || "http://127.0.0.1:8765";
const browserPath = process.env.PLAYWRIGHT_BROWSER || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function seek(page, data, timestamp) {
  const offset = Math.max(0, Math.round(timestamp - data.timelineStart));
  await page.locator("#timeline").evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, offset);
  await page.waitForTimeout(100);
}

let browser;
(async () => {
  browser = await chromium.launch({ headless: true, executablePath: browserPath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#replayShell")?.getAttribute("aria-busy") === "false");

  assert.equal(await page.locator("#groupSelect option").count(), 11, "should expose 11 active groups");
  assert.equal(await page.locator(".member-chip").count(), 3, "selected group should expose three members");
  assert.equal(await page.locator(".context-pane").count(), 2, "notes and chat should remain available on desktop");
  const desktopPanes = await page.locator(".context-pane").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).display));
  assert.equal(desktopPanes.filter((value) => value !== "none").length, 1, "desktop should use compact notes/chat tabs to leave room for the visualization");
  assert.equal(await page.locator("#chatPane").isVisible(), true, "room chat / AI should be the default context tab");
  assert.equal(await page.locator('[data-context="chat"]').getAttribute("aria-selected"), "true");
  assert.equal(await page.locator("#previewPanel").isVisible(), true, "live visualization panel should be visible");

  const selected = await page.evaluate(async () => {
    const index = await (await fetch("/data/index.json")).json();
    const meta = index.groups.find((item) => item.id === document.querySelector("#groupSelect").value);
    return await (await fetch(`/${meta.file}`)).json();
  });
  assert.equal(selected.members.length, 3);
  assert.ok(selected.code.length > 0 && selected.notes.length > 0 && selected.chat.length > 0);

  const firstCode = selected.code[0];
  await seek(page, selected, firstCode.t);
  const renderedCode = await page.locator("#codeView .code-line pre").evaluateAll((nodes) => nodes.map((node) => {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(".cursor-tag").forEach((tag) => tag.remove());
    return clone.textContent;
  }));
  assert.deepEqual(renderedCode, firstCode.code.replaceAll("\r\n", "\n").split("\n").map((line) => line || " "));
  assert.match(await page.locator("#codeActor").innerText(), new RegExp(firstCode.actor));
  assert.match(await page.locator("#previewState").innerText(), /搭建中|输入中/, "an incomplete visualization must not show a future result");
  assert.equal(await page.locator("#visualization svg").count(), 0, "future visualization must stay hidden");

  const renderableCode = selected.code.find((item) => {
    try {
      const spec = JSON.parse(item.code);
      return Boolean(spec.mark || spec.layer || spec.hconcat || spec.vconcat || spec.concat || spec.repeat || spec.facet);
    } catch {
      return false;
    }
  });
  assert.ok(renderableCode, "default group should contain a renderable Vega-Lite snapshot");
  await seek(page, selected, renderableCode.t);
  await page.waitForFunction(() => document.querySelector("#previewState")?.textContent === "已同步", null, { timeout: 10000 });
  assert.ok((await page.locator("#visualization svg").count()) > 0, "renderable code should produce an SVG visualization");
  assert.match(await page.locator("#previewMeta").innerText(), new RegExp(`代码快照`));
  await page.locator("#previewToggle").click();
  await page.waitForTimeout(150);
  const expandedPreview = await page.evaluate(() => {
    const stage = document.querySelector("#previewStage").getBoundingClientRect();
    const code = document.querySelector("#codePanel").getBoundingClientRect();
    const svg = document.querySelector("#visualization svg").getBoundingClientRect();
    return {
      expanded: document.querySelector(".workspace").classList.contains("is-preview-expanded"),
      pressed: document.querySelector("#previewToggle").getAttribute("aria-pressed"),
      codeDisplay: getComputedStyle(document.querySelector("#codePanel")).display,
      contextDisplay: getComputedStyle(document.querySelector(".context-panel")).display,
      stageWidth: stage.width,
      codeWidth: code.width,
      svgWidth: svg.width,
      svgHeight: svg.height,
      stageHeight: stage.height,
      scale: Number(document.querySelector("#visualization").dataset.fitScale),
    };
  });
  assert.equal(expandedPreview.expanded, true, "maximize button should expand the live result beside the code editor");
  assert.equal(expandedPreview.pressed, "true");
  assert.notEqual(expandedPreview.codeDisplay, "none", "expanded mode must retain the code editor");
  assert.equal(expandedPreview.contextDisplay, "none");
  assert.ok(expandedPreview.stageWidth > 750 && expandedPreview.codeWidth > 500, "code and expanded result should both have usable width");
  assert.ok(expandedPreview.scale >= 0.45, "smart sizing should not shrink tall charts below the readable minimum");
  assert.ok(expandedPreview.svgWidth >= expandedPreview.stageWidth * 0.45, "a tall chart should still occupy a readable share of the result area");

  const stageBox = await page.locator("#previewStage").boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  const scaleBeforeWheel = Number(await page.locator("#visualization").getAttribute("data-fit-scale"));
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(80);
  const scaleAfterZoomIn = Number(await page.locator("#visualization").getAttribute("data-fit-scale"));
  assert.ok(scaleAfterZoomIn > scaleBeforeWheel, "mouse wheel up should zoom the visualization in");
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(80);
  const scaleAfterZoomOut = Number(await page.locator("#visualization").getAttribute("data-fit-scale"));
  assert.ok(scaleAfterZoomOut < scaleAfterZoomIn, "mouse wheel down should zoom the visualization out");
  await page.locator("#previewZoom").click();
  await page.waitForTimeout(80);
  assert.equal(Number(await page.locator("#visualization").getAttribute("data-fit-scale")), scaleBeforeWheel, "zoom readout should restore smart sizing");
  await page.screenshot({ path: path.join(__dirname, "replay-preview-expanded.png"), fullPage: true });
  await page.locator("#previewToggle").click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator("#codePanel").isVisible(), true, "restore button should return the three-column workspace");

  await page.locator('[data-context="notes"]').click();
  const firstNote = selected.notes[0];
  await seek(page, selected, firstNote.t - 1);
  assert.equal(await page.locator("#noteView .note-text").count(), 0, "note must not appear early");
  await seek(page, selected, firstNote.t);
  assert.equal(await page.locator("#noteView .note-text").innerText(), firstNote.text || "（该快照只有图片或空内容）");
  assert.match(await page.locator("#noteActor").innerText(), new RegExp(firstNote.actor));
  const imageNote = selected.notes.find((item) => item.images.length > 0);
  assert.ok(imageNote, "default group should include note images");
  await seek(page, selected, imageNote.t);
  await page.waitForFunction(() => [...document.querySelectorAll("#noteView img")].every((image) => image.complete && image.naturalWidth > 0));
  assert.equal(await page.locator("#noteView img").count(), imageNote.images.length, "deduplicated note images should load");

  const firstReply = selected.chat.find((item) => item.kind === "ai-reply");
  assert.ok(firstReply, "default group should include AI replies");
  const repliesBefore = selected.chat.filter((item) => item.kind === "ai-reply" && item.t < firstReply.t).length;
  await seek(page, selected, firstReply.t - 1);
  assert.equal(await page.locator(".message.ai-reply").count(), repliesBefore, "AI reply must not appear before its timestamp");
  await seek(page, selected, firstReply.t);
  assert.equal(await page.locator(".message.ai-reply").count(), repliesBefore + 1, "AI reply should appear at its timestamp");

  const firstCursor = selected.cursor[0];
  await seek(page, selected, firstCursor.t);
  assert.match(await page.locator("#cursorSummary").innerText(), new RegExp(firstCursor.actor));

  const firstAction = selected.actions[0];
  await seek(page, selected, firstAction.t);
  assert.ok((await page.locator(".action-stat.has-events").count()) >= 1, "actions should update at their timestamps");

  const completion = selected.completion[0];
  assert.ok(completion, "default group should have completion data");
  await seek(page, selected, completion.t - 1);
  assert.match(await page.locator("#completionStatus").innerText(), /尚未完成/);
  await seek(page, selected, completion.t);
  assert.match(await page.locator("#completionStatus").innerText(), new RegExp(completion.actor));

  await seek(page, selected, selected.timelineStart);
  const beforePlay = Number(await page.locator("#timeline").inputValue());
  await page.locator("#playButton").click();
  await page.waitForTimeout(300);
  const duringPlay = Number(await page.locator("#timeline").inputValue());
  assert.ok(duringPlay > beforePlay, "timeline should advance while playing");
  await page.locator("#playButton").click();
  const pausedAt = Number(await page.locator("#timeline").inputValue());
  await page.waitForTimeout(200);
  assert.equal(Number(await page.locator("#timeline").inputValue()), pausedAt, "pause should stop timeline");

  const middleCode = selected.code[Math.floor(selected.code.length / 2)];
  await seek(page, selected, middleCode.t);
  const visibleOwners = await page.locator("#codeView .code-line").evaluateAll((nodes) => [...new Set(nodes.map((node) => node.dataset.owner))]);
  assert.ok(visibleOwners.length >= 2, "unchanged lines should retain earlier owners while overwritten lines use the latest editor");
  const layout = await page.evaluate(() => {
    const lower = document.querySelector(".lower-panel").getBoundingClientRect();
    const activity = document.querySelector("#activityList").getBoundingClientRect();
    const actions = document.querySelector("#actionSummary").getBoundingClientRect();
    const preview = document.querySelector("#previewPanel").getBoundingClientRect();
    return { lower: lower.height, activity: activity.height, actions: actions.height, preview: preview.width, pageWidth: document.documentElement.scrollWidth, viewport: innerWidth };
  });
  assert.ok(layout.lower >= 160 && layout.activity >= 120 && layout.actions >= 90, "lower panels must remain visible with code loaded");
  assert.ok(layout.preview >= 300, "desktop visualization should have usable width");
  assert.ok(layout.pageWidth <= layout.viewport, "desktop should not overflow horizontally");

  const mixedNote = selected.notes.find((item) => new Set(item.owners).size >= 2);
  assert.ok(mixedNote, "default group should include a note with multiple owners");
  await seek(page, selected, mixedNote.t);
  const noteOwners = await page.locator("#noteView .note-line").evaluateAll((nodes) => [...new Set(nodes.map((node) => node.dataset.owner))]);
  assert.ok(noteOwners.length >= 2, "note blocks should retain per-editor ownership");
  await page.screenshot({ path: path.join(__dirname, "replay-note-ownership.png"), fullPage: true });

  const analysisHref = await page.locator("#analysisLink").getAttribute("href");
  assert.match(analysisHref, new RegExp(`analysis\\.html\\?group=${selected.groupId}`), "analysis link should preserve selected group");

  await page.screenshot({ path: path.join(__dirname, "replay-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 900, height: 720 });
  await page.waitForTimeout(120);
  assert.equal(await page.locator(".compact-tabs").evaluate((node) => getComputedStyle(node).display !== "none"), true);
  assert.equal(await page.locator(".context-pane:visible").count(), 1, "narrow layout should use one context pane at a time");
  await page.locator('[data-context="chat"]').click();
  assert.equal(await page.locator("#chatPane").isVisible(), true);
  const narrow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, timeline: document.querySelector("#timeline").getBoundingClientRect().width }));
  assert.ok(narrow.scrollWidth <= narrow.width && narrow.timeline > 0, "narrow layout should keep controls visible without page overflow");
  await page.screenshot({ path: path.join(__dirname, "replay-narrow.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(120);
  const mobile = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    workspaceRows: getComputedStyle(document.querySelector(".workspace")).gridTemplateRows,
    previewVisible: document.querySelector("#previewPanel").getBoundingClientRect().height > 0,
    contextVisible: document.querySelector(".context-panel").getBoundingClientRect().height > 0,
  }));
  assert.ok(mobile.previewVisible && mobile.contextVisible, "mobile workspace should keep preview and context accessible by vertical scrolling");
  assert.ok(mobile.workspaceRows.split(" ").length >= 3, "mobile workspace should stack its three main areas");
  assert.ok(mobile.scrollWidth <= mobile.width, "mobile layout should not overflow horizontally");
  await page.screenshot({ path: path.join(__dirname, "replay-mobile.png"), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.selectOption("#groupSelect", "zju-11");
  await page.waitForFunction(() => document.querySelector("#replayShell")?.getAttribute("aria-busy") === "false");
  const aiGroup = await page.evaluate(async () => {
    const index = await (await fetch("/data/index.json")).json();
    const meta = index.groups.find((item) => item.id === "zju-11");
    return await (await fetch(`/${meta.file}`)).json();
  });
  const aiOwnedSnapshot = aiGroup.code.find((item) => item.owners.includes("AI"));
  assert.ok(aiOwnedSnapshot, "at least one group should contain verifiable AI-matched inserted lines");
  await seek(page, aiGroup, aiOwnedSnapshot.t);
  assert.ok((await page.locator('#codeView .code-line[data-owner="AI"]').count()) > 0, "AI-matched lines should use AI ownership");
  const aiLineColor = await page.locator('#codeView .code-line[data-owner="AI"]').first().evaluate((node) => getComputedStyle(node).backgroundColor);
  assert.notEqual(aiLineColor, "rgba(0, 0, 0, 0)", "AI ownership should have a visible pink background");
  await page.screenshot({ path: path.join(__dirname, "replay-ai-ownership.png"), fullPage: true });

  assert.deepEqual(errors, [], `browser errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({
    group: selected.groupId,
    members: selected.members.map((item) => item.id),
    code: selected.code.length,
    notes: selected.notes.length,
    chat: selected.chat.length,
    playbackAdvancedMs: duringPlay - beforePlay,
    desktopScreenshot: path.join(__dirname, "replay-desktop.png"),
    narrowScreenshot: path.join(__dirname, "replay-narrow.png"),
    mobileScreenshot: path.join(__dirname, "replay-mobile.png"),
    expandedPreviewScreenshot: path.join(__dirname, "replay-preview-expanded.png"),
    aiOwnershipScreenshot: path.join(__dirname, "replay-ai-ownership.png"),
  }, null, 2));
  await browser.close();
  browser = null;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
