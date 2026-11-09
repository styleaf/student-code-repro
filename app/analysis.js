const state = {
  index: null,
  data: null,
  selectedWindow: 0,
};

const el = {
  main: document.querySelector("#analysisMain"),
  group: document.querySelector("#groupSelect"),
  members: document.querySelector("#memberLegend"),
  replayLink: document.querySelector("#replayLink"),
  metrics: document.querySelector("#overviewMetrics"),
  behaviorLegend: document.querySelector("#behaviorLegend"),
  participation: document.querySelector("#participationView"),
  icapTimeline: document.querySelector("#icapTimeline"),
  icapDetail: document.querySelector("#icapDetail"),
  anomalyList: document.querySelector("#anomalyList"),
  anomalyMeta: document.querySelector("#anomalyMeta"),
  aiList: document.querySelector("#aiAnalysisList"),
  aiMeta: document.querySelector("#aiMeta"),
  codeView: document.querySelector("#codeAnalysisView"),
  codeMeta: document.querySelector("#codeMeta"),
  noteView: document.querySelector("#noteAnalysisView"),
  noteMeta: document.querySelector("#noteMeta"),
  classBody: document.querySelector("#classTableBody"),
};

const timeFormat = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Shanghai",
});

const BEHAVIORS = [
  ["code", "代码", "#4383c4"],
  ["notes", "笔记", "#8a62b5"],
  ["chat", "消息", "#d05b8f"],
  ["actions", "操作", "#b06d0d"],
  ["cursor", "光标", "#4a8e69"],
];

const ICAP_COLORS = {
  Interactive: "#9fdfb7",
  Constructive: "#afd2fa",
  Active: "#f3d178",
  Passive: "#d6dbd8",
  None: "#f4c4c1",
  Unknown: "#e7eae8",
};

const severityRank = { high: 3, medium: 2, low: 1, unknown: 0 };
const severityLabels = { high: "高", medium: "中", low: "低", unknown: "未标注" };
const severityColors = { high: "#f1b0ab", medium: "#f3d178", low: "#c9dfd2", unknown: "#e5e9e6" };

function durationText(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}小时${minutes}分` : `${minutes}分${seconds}秒`;
}

function empty(container, text) {
  container.replaceChildren();
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = text;
  container.append(node);
}

function memberColor(actor) {
  if (actor === "AI") return "#f4b6d2";
  return state.data?.members.find((item) => item.id === actor)?.color || "#e7eae8";
}

function memberName(actor) {
  return actor === "AI" ? "AI文本匹配" : actor || "未知成员";
}

function icapColor(level) {
  return ICAP_COLORS[level] || ICAP_COLORS.Unknown;
}

function appendMetric(label, value, detail) {
  const box = document.createElement("div");
  box.className = "metric";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = value;
  const detailNode = document.createElement("small");
  detailNode.textContent = detail;
  box.append(labelNode, valueNode, detailNode);
  el.metrics.append(box);
}

function dominantIcap(windows) {
  const counts = new Map();
  windows.forEach((window) => counts.set(window.level, (counts.get(window.level) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || ["无", 0];
}

function renderHeader() {
  el.members.replaceChildren();
  state.data.members.forEach((person) => {
    const chip = document.createElement("span");
    chip.className = "member-chip";
    chip.style.setProperty("--actor-color", person.color);
    chip.textContent = person.id;
    el.members.append(chip);
  });
  el.replayLink.href = `/app/index.html?group=${encodeURIComponent(state.data.groupId)}`;
  history.replaceState(null, "", `/app/analysis.html?group=${encodeURIComponent(state.data.groupId)}`);

  const behaviorTotal = state.data.participation.reduce((sum, item) => sum + item.total, 0);
  const [dominant, dominantCount] = dominantIcap(state.data.icapWindows);
  const anomalyTotal = Object.values(state.data.anomalyCounts).reduce((sum, value) => sum + value, 0);
  const completion = state.data.completion[0];
  el.metrics.replaceChildren();
  appendMetric("活动时长", durationText(state.data.timelineEnd - state.data.timelineStart), `${timeFormat.format(new Date(state.data.timelineStart))} 开始`);
  appendMetric("行为记录", behaviorTotal.toLocaleString("zh-CN"), "代码、笔记、光标、消息和操作");
  appendMetric("最多ICAP窗口", dominant, `${dominantCount}/${state.data.icapWindows.length} 个窗口`);
  appendMetric("AI交互", String(state.data.aiInteractions.length), "按48个唯一问答对去重后统计");
  appendMetric("异常提示", anomalyTotal.toLocaleString("zh-CN"), "窗口级提示，可能重复");
  appendMetric("任务完成", completion ? "已完成" : "无记录", completion ? `${completion.actor} · ${timeFormat.format(new Date(completion.t))}` : "不能推断是否实际完成");
}

function renderBehaviorLegend() {
  el.behaviorLegend.replaceChildren();
  BEHAVIORS.forEach(([, label, color]) => {
    const item = document.createElement("span");
    const swatch = document.createElement("i");
    swatch.style.setProperty("--kind-color", color);
    item.append(swatch, document.createTextNode(label));
    el.behaviorLegend.append(item);
  });
}

function renderParticipation() {
  renderBehaviorLegend();
  el.participation.replaceChildren();
  const rows = [...state.data.participation];
  const aiCode = state.data.artifactAttribution?.finalCode?.AI || 0;
  const aiNote = state.data.artifactAttribution?.finalNote?.AI || 0;
  if (aiCode || aiNote) {
    rows.push({ id: "AI", color: memberColor("AI"), counts: {}, total: 0, finalCodeLines: aiCode, finalNoteLines: aiNote });
  }
  const maxTotal = Math.max(1, ...rows.map((item) => item.total));
  rows.forEach((person) => {
    const row = document.createElement("div");
    row.className = "participation-row";
    const name = document.createElement("div");
    name.className = "participant-name";
    const strong = document.createElement("strong");
    strong.textContent = memberName(person.id);
    const small = document.createElement("small");
    small.textContent = person.id === "AI" ? "逐字匹配来源，不是编辑器操作者" : `${person.total.toLocaleString("zh-CN")} 条行为记录`;
    name.style.borderLeft = `4px solid ${person.color}`;
    name.style.paddingLeft = "7px";
    name.append(strong, small);

    const track = document.createElement("div");
    track.className = "behavior-track";
    BEHAVIORS.forEach(([key, label, color]) => {
      const count = person.counts?.[key] || 0;
      if (!count) return;
      const segment = document.createElement("span");
      segment.className = "behavior-segment";
      segment.style.setProperty("--kind-color", color);
      segment.style.width = `${(count / maxTotal) * 100}%`;
      segment.title = `${label} ${count}条`;
      track.append(segment);
    });

    const artifacts = document.createElement("div");
    artifacts.className = "artifact-counts";
    const code = document.createElement("span");
    code.innerHTML = `终稿代码 <strong>${person.finalCodeLines}</strong> 行`;
    const note = document.createElement("span");
    note.innerHTML = `终稿笔记 <strong>${person.finalNoteLines}</strong> 段`;
    artifacts.append(code, note);
    row.append(name, track, artifacts);
    el.participation.append(row);
  });
}

function renderIcapTimeline() {
  el.icapTimeline.replaceChildren();
  const windows = state.data.icapWindows;
  if (!windows.length) {
    empty(el.icapTimeline, "该组没有ICAP窗口分析");
    empty(el.icapDetail, "没有可显示的自动分析");
    return;
  }
  const start = Math.min(state.data.timelineStart, ...windows.map((item) => item.tStart));
  const end = Math.max(state.data.timelineEnd, ...windows.map((item) => item.tEnd));
  const duration = Math.max(1, end - start);
  windows.forEach((window, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icap-window ${index === state.selectedWindow ? "is-selected" : ""}`;
    button.style.left = `${((window.tStart - start) / duration) * 100}%`;
    button.style.width = `${Math.max(0.7, ((window.tEnd - window.tStart) / duration) * 100)}%`;
    button.style.setProperty("--icap-color", icapColor(window.level));
    button.title = `${timeFormat.format(new Date(window.tStart))} · ${window.level} · ${window.events}条事件`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => selectIcapWindow(index));
    el.icapTimeline.append(button);
  });
  const startLabel = document.createElement("span");
  startLabel.className = "icap-axis-label";
  startLabel.textContent = timeFormat.format(new Date(start));
  const endLabel = document.createElement("span");
  endLabel.className = "icap-axis-label end";
  endLabel.textContent = timeFormat.format(new Date(end));
  el.icapTimeline.append(startLabel, endLabel);
  renderIcapDetail();
}

function selectIcapWindow(index) {
  state.selectedWindow = Math.max(0, Math.min(state.data.icapWindows.length - 1, index));
  el.icapTimeline.querySelectorAll(".icap-window").forEach((node, nodeIndex) => node.classList.toggle("is-selected", nodeIndex === state.selectedWindow));
  renderIcapDetail();
}

function renderIcapDetail() {
  el.icapDetail.replaceChildren();
  const window = state.data.icapWindows[state.selectedWindow];
  if (!window) return;
  const heading = document.createElement("div");
  heading.className = "detail-heading";
  const badge = document.createElement("span");
  badge.className = "level-badge";
  badge.style.setProperty("--badge-color", icapColor(window.level));
  badge.textContent = window.level;
  const title = document.createElement("strong");
  const confidence = typeof window.confidence === "number" ? ` · 置信度 ${Math.round(window.confidence * 100)}%` : "";
  title.textContent = `${timeFormat.format(new Date(window.tStart))}–${timeFormat.format(new Date(window.tEnd))} · ${window.events}条事件${confidence}`;
  heading.append(badge, title);
  const summary = document.createElement("p");
  summary.className = "detail-summary";
  summary.textContent = window.summary || window.activitySummary || "该窗口没有文字摘要。";
  el.icapDetail.append(heading, summary);
  if (window.activitySummary && window.activitySummary !== window.summary) {
    const secondary = document.createElement("p");
    secondary.className = "detail-secondary";
    secondary.textContent = window.activitySummary;
    el.icapDetail.append(secondary);
  }
  if (window.patterns.length) {
    const patterns = document.createElement("div");
    patterns.className = "pattern-row";
    window.patterns.forEach((pattern) => {
      const item = document.createElement("span");
      item.textContent = pattern;
      patterns.append(item);
    });
    el.icapDetail.append(patterns);
  }
  const scores = Object.entries(window.interactionScores || {});
  if (scores.length) {
    const row = document.createElement("div");
    row.className = "score-row";
    scores.forEach(([actor, score]) => {
      const item = document.createElement("span");
      item.style.setProperty("--actor-color", memberColor(actor));
      item.textContent = `${actor} · 互动分 ${score}`;
      row.append(item);
    });
    el.icapDetail.append(row);
  }
}

function renderAnomalies() {
  const grouped = new Map();
  state.data.icapWindows.forEach((window, windowIndex) => {
    window.anomalies.forEach((anomaly) => {
      if (!grouped.has(anomaly.type)) grouped.set(anomaly.type, []);
      grouped.get(anomaly.type).push({ ...anomaly, windowIndex, tStart: window.tStart });
    });
  });
  const groups = [...grouped.entries()].sort((a, b) => b[1].length - a[1].length);
  el.anomalyMeta.textContent = `${groups.length}类 · ${groups.reduce((sum, [, items]) => sum + items.length, 0)}次窗口提示`;
  el.anomalyList.replaceChildren();
  if (!groups.length) {
    empty(el.anomalyList, "该组没有协作异常分析记录");
    return;
  }
  groups.forEach(([type, items]) => {
    const severity = [...items].sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0))[0].severity;
    const latest = items.at(-1);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "anomaly-item";
    button.addEventListener("click", () => {
      selectIcapWindow(latest.windowIndex);
      document.querySelector(".icap-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    const typeNode = document.createElement("span");
    typeNode.className = "anomaly-type";
    typeNode.textContent = type;
    const count = document.createElement("span");
    count.className = "anomaly-count";
    count.textContent = `${items.length}次`;
    const description = document.createElement("span");
    description.className = "anomaly-description";
    const severityBadge = document.createElement("span");
    severityBadge.className = "severity-badge";
    severityBadge.style.setProperty("--badge-color", severityColors[severity] || severityColors.unknown);
    severityBadge.textContent = `${severityLabels[severity] || severity}风险`;
    description.append(severityBadge, document.createTextNode(` ${latest.description}`));
    button.append(typeNode, count, description);
    el.anomalyList.append(button);
  });
}

function renderAI() {
  el.aiMeta.textContent = `${state.data.aiInteractions.length}个唯一问答对`;
  el.aiList.replaceChildren();
  if (!state.data.aiInteractions.length) {
    empty(el.aiList, "该组没有可用的AI交互分析");
    return;
  }
  state.data.aiInteractions.forEach((item, index) => {
    const details = document.createElement("details");
    details.className = "analysis-entry";
    if (index === 0) details.open = true;
    const summary = document.createElement("summary");
    const time = document.createElement("span");
    time.className = "entry-time";
    time.textContent = timeFormat.format(new Date(item.questionT));
    const question = document.createElement("span");
    question.className = "entry-question";
    question.textContent = item.question;
    summary.append(time, question);
    const body = document.createElement("div");
    body.className = "entry-body";
    const badges = document.createElement("div");
    badges.className = "entry-badges";
    const member = document.createElement("span");
    member.className = "entry-member";
    member.style.setProperty("--actor-color", memberColor(item.user));
    member.textContent = item.user;
    badges.append(member);
    [[item.questionType, "#dce9f7"], [item.bloom, "#e1d7ef"], [`AI角色：${item.aiRole}`, "#f4b6d2"]].forEach(([label, color]) => {
      const badge = document.createElement("span");
      badge.className = "analysis-badge";
      badge.style.setProperty("--badge-color", color);
      badge.textContent = label;
      badges.append(badge);
    });
    body.append(badges);
    [["触发背景", item.triggerFactors.join("；") || item.learningNeeds], ["小组影响", item.groupImpact], ["学习结果", item.learningOutcome], ["知识建构", item.knowledgeBuilding]].forEach(([label, value]) => {
      if (!value) return;
      const paragraph = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${label}：`;
      paragraph.append(strong, document.createTextNode(value));
      body.append(paragraph);
    });
    details.append(summary, body);
    el.aiList.append(details);
  });
}

function renderCodeAnalysis() {
  const milestones = [];
  const seen = new Set();
  state.data.codeWindows.forEach((window) => {
    window.milestones.forEach((item) => {
      const key = `${item.timestamp}|${item.description}`;
      if (!seen.has(key)) {
        seen.add(key);
        milestones.push(item);
      }
    });
  });
  el.codeMeta.textContent = `${state.data.codeWindows.length}个窗口 · ${milestones.length}个去重里程碑`;
  el.codeView.replaceChildren();
  if (!state.data.codeWindows.length) {
    empty(el.codeView, "该组没有代码演化分析");
    return;
  }
  const latest = state.data.codeWindows.at(-1);
  if (latest.chartTypes.length || latest.patterns.length) {
    const summary = document.createElement("div");
    summary.className = "note-summary";
    const chartText = latest.chartTypes.length ? `图表演化：${latest.chartTypes.join(" → ")}` : "";
    const patternText = latest.patterns.length ? `行为模式：${latest.patterns.join("；")}` : "";
    summary.textContent = [chartText, patternText].filter(Boolean).join("。") || "最新窗口没有演化摘要。";
    el.codeView.append(summary);
  }
  milestones.slice(-20).forEach((item) => {
    const row = document.createElement("div");
    row.className = "milestone";
    const time = document.createElement("time");
    time.textContent = item.timestamp;
    const content = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.description;
    const detail = document.createElement("p");
    detail.textContent = `${item.member || "成员未标明"}${item.type ? ` · ${item.type}` : ""}${typeof item.significance === "number" ? ` · 显著性 ${item.significance}` : ""}`;
    content.append(title, detail);
    row.append(time, content);
    el.codeView.append(row);
  });
}

function renderNoteAnalysis() {
  const full = state.data.fullNoteAnalysis;
  const sourceWindows = state.data.noteWindows;
  const base = full || sourceWindows.at(-1);
  const insights = full
    ? full.insights
    : sourceWindows.flatMap((window) => window.insights).filter((item, index, all) => all.findIndex((candidate) => candidate.insight === item.insight) === index);
  el.noteMeta.textContent = full ? `完整笔记分析 · ${full.events}个快照` : `${sourceWindows.length}个抽样窗口 · ${insights.length}条去重见解`;
  el.noteView.replaceChildren();
  if (!base) {
    empty(el.noteView, "该组没有笔记分析记录");
    return;
  }
  const summary = document.createElement("div");
  summary.className = "note-summary";
  summary.textContent = base.overallSummary || "没有整体摘要。";
  if (base.keyFindings?.length) {
    const list = document.createElement("ul");
    list.className = "finding-list";
    base.keyFindings.forEach((finding) => {
      const item = document.createElement("li");
      item.textContent = finding;
      list.append(item);
    });
    summary.append(list);
  }
  el.noteView.append(summary);
  [...insights].sort((a, b) => (b.significance || 0) - (a.significance || 0)).slice(0, 20).forEach((item) => {
    const row = document.createElement("div");
    row.className = "insight-row";
    const badges = document.createElement("div");
    badges.className = "entry-badges";
    [[item.category || "未分类", "#e1d7ef"], [item.source || "来源未标明", "#dce9f7"], [`显著性 ${item.significance ?? "未标明"}`, "#f3d178"]].forEach(([label, color]) => {
      const badge = document.createElement("span");
      badge.className = "analysis-badge";
      badge.style.setProperty("--badge-color", color);
      badge.textContent = label;
      badges.append(badge);
    });
    const text = document.createElement("p");
    text.textContent = item.insight;
    row.append(badges, text);
    el.noteView.append(row);
  });
}

function appendIcapMini(cell, counts) {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const mini = document.createElement("div");
  mini.className = "icap-mini";
  mini.title = Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(" · ") || "无ICAP窗口";
  Object.entries(counts).forEach(([level, count]) => {
    const segment = document.createElement("i");
    segment.style.setProperty("--icap-color", icapColor(level));
    segment.style.width = `${total ? (count / total) * 100 : 0}%`;
    mini.append(segment);
  });
  cell.append(mini);
}

function renderClassTable() {
  el.classBody.replaceChildren();
  state.index.groups.forEach((group) => {
    const row = document.createElement("tr");
    row.classList.toggle("is-selected", group.id === state.data?.groupId);
    row.addEventListener("click", () => {
      el.group.value = group.id;
      loadGroup(group).catch(showError);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    const name = document.createElement("td");
    name.textContent = group.name;
    const events = document.createElement("td");
    events.textContent = group.events.toLocaleString("zh-CN");
    const icap = document.createElement("td");
    appendIcapMini(icap, group.icap || {});
    const ai = document.createElement("td");
    ai.textContent = String(group.ai);
    const notes = document.createElement("td");
    notes.textContent = String(group.noteInsights);
    const anomalies = document.createElement("td");
    anomalies.textContent = String(group.anomalies);
    const completed = document.createElement("td");
    completed.textContent = group.completed ? "已记录" : "无记录";
    row.append(name, events, icap, ai, notes, anomalies, completed);
    el.classBody.append(row);
  });
}

function renderAll() {
  renderHeader();
  renderParticipation();
  renderIcapTimeline();
  renderAnomalies();
  renderAI();
  renderCodeAnalysis();
  renderNoteAnalysis();
  renderClassTable();
}

async function loadGroup(meta) {
  el.main.setAttribute("aria-busy", "true");
  const response = await fetch(`/${meta.file}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`事后分析数据读取失败：${response.status}`);
  state.data = await response.json();
  state.selectedWindow = 0;
  renderAll();
  el.main.setAttribute("aria-busy", "false");
}

async function initialize() {
  const response = await fetch("/data/analysis/index.json", { cache: "no-store" });
  if (!response.ok) throw new Error("事后分析索引不存在，请先运行 build_data.py");
  state.index = await response.json();
  state.index.groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${group.name} · ${group.members}人`;
    el.group.append(option);
  });
  const requested = new URLSearchParams(location.search).get("group");
  const selected = state.index.groups.find((group) => group.id === requested)
    || state.index.groups.find((group) => group.id === state.index.defaultGroup)
    || state.index.groups[0];
  el.group.value = selected.id;
  await loadGroup(selected);
}

function showError(error) {
  console.error(error);
  el.main.setAttribute("aria-busy", "false");
  empty(el.metrics, error.message);
}

el.group.addEventListener("change", () => loadGroup(state.index.groups.find((group) => group.id === el.group.value)).catch(showError));
initialize().catch(showError);
