const elements = {
  shell: document.querySelector("#replayShell"),
  group: document.querySelector("#groupSelect"),
  student: document.querySelector("#studentSelect"),
  onlineStatus: document.querySelector("#onlineStatus"),
  tabStatus: document.querySelector("#tabStatus"),
  offlineNotice: document.querySelector("#offlineNotice"),
  codeMeta: document.querySelector("#codeMeta"),
  cursorPosition: document.querySelector("#cursorPosition"),
  changeSummary: document.querySelector("#changeSummary"),
  codeView: document.querySelector("#codeView"),
  aiMeta: document.querySelector("#aiMeta"),
  aiMessages: document.querySelector("#aiMessages"),
  activityList: document.querySelector("#activityList"),
  verificationItems: [...document.querySelectorAll(".verification-item")],
  previewStatus: document.querySelector("#previewStatus"),
  dataStatus: document.querySelector("#dataStatus"),
  pdfStatus: document.querySelector("#pdfStatus"),
  markerLane: document.querySelector("#markerLane"),
  timeline: document.querySelector("#timeline"),
  play: document.querySelector("#playButton"),
  restart: document.querySelector("#restartButton"),
  speed: document.querySelector("#speedSelect"),
  currentTime: document.querySelector("#currentTime"),
  elapsedTime: document.querySelector("#elapsedTime"),
  dataNote: document.querySelector("#dataNote"),
};

const clockFormat = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 1,
  hour12: false,
  timeZone: "Asia/Shanghai",
});

const state = {
  index: null,
  studentData: null,
  timelineEvents: [],
  current: 0,
  playing: false,
  speed: 60,
  animationFrame: 0,
  lastFrame: 0,
  lastRender: 0,
  renderCache: {},
};

function lastIndexAt(items, time, key = "t") {
  let low = 0;
  let high = items.length - 1;
  let answer = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle][key] <= time) {
      answer = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return answer;
}

function classifyChange(change) {
  if (change.old === change.new) return "none";
  if (!change.old && change.new) return "add";
  if (change.old && !change.new) return "delete";
  return "modify";
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function setPlaying(playing) {
  state.playing = playing;
  elements.play.textContent = playing ? "Ⅱ" : "▶";
  elements.play.title = playing ? "暂停" : "播放";
  elements.play.setAttribute("aria-label", playing ? "暂停" : "播放");
  if (playing) {
    if (state.studentData && state.current >= state.studentData.timelineEnd) {
      seek(state.studentData.timelineStart, false);
    }
    state.lastFrame = performance.now();
    cancelAnimationFrame(state.animationFrame);
    state.animationFrame = requestAnimationFrame(tick);
  } else {
    cancelAnimationFrame(state.animationFrame);
  }
}

function tick(now) {
  if (!state.playing || !state.studentData) return;
  const elapsed = Math.min(250, now - state.lastFrame);
  state.lastFrame = now;
  state.current = Math.min(state.studentData.timelineEnd, state.current + elapsed * state.speed);
  updateTimelineControl();
  if (now - state.lastRender > 70 || state.current >= state.studentData.timelineEnd) {
    renderState();
    state.lastRender = now;
  }
  if (state.current >= state.studentData.timelineEnd) {
    setPlaying(false);
    renderState(true);
    return;
  }
  state.animationFrame = requestAnimationFrame(tick);
}

function updateTimelineControl() {
  if (!state.studentData) return;
  const start = state.studentData.timelineStart;
  elements.timeline.value = String(Math.max(0, Math.round(state.current - start)));
  elements.currentTime.textContent = clockFormat.format(new Date(state.current));
  elements.elapsedTime.textContent = `${formatDuration(state.current - start)} / ${formatDuration(
    state.studentData.timelineEnd - start,
  )}`;
}

function seek(time, pause = true) {
  if (!state.studentData) return;
  if (pause) setPlaying(false);
  state.current = Math.min(state.studentData.timelineEnd, Math.max(state.studentData.timelineStart, time));
  state.renderCache = {};
  updateTimelineControl();
  renderState(true);
}

function renderStatus() {
  const data = state.studentData;
  const statusIndex = lastIndexAt(data.status, state.current);
  const status = statusIndex >= 0 ? data.status[statusIndex].status : "unknown";
  const offline = status === "offline";
  elements.onlineStatus.className = "status-pill";
  if (status === "online") {
    elements.onlineStatus.classList.add("status-online");
    elements.onlineStatus.textContent = "在线记录";
  } else if (offline) {
    elements.onlineStatus.classList.add("status-offline");
    elements.onlineStatus.textContent = "离线记录";
  } else {
    elements.onlineStatus.classList.add("status-unknown");
    elements.onlineStatus.textContent = "状态未记录";
  }
  elements.shell.classList.toggle("is-offline", offline);
  elements.offlineNotice.hidden = !offline;

  const tabActions = data.actions.filter((item) => item.type === "tab-switch");
  const tabIndex = lastIndexAt(tabActions, state.current);
  elements.tabStatus.textContent = tabIndex >= 0 ? `记录页签：${tabActions[tabIndex].label}` : "页签未记录";
}

function renderCode(force = false) {
  const data = state.studentData;
  const codeIndex = lastIndexAt(data.code, state.current);
  const cursorIndex = lastIndexAt(data.cursor, state.current);
  if (!force && state.renderCache.codeIndex === codeIndex && state.renderCache.cursorIndex === cursorIndex) return;
  state.renderCache.codeIndex = codeIndex;
  state.renderCache.cursorIndex = cursorIndex;

  elements.codeView.replaceChildren();
  if (codeIndex < 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前时间点之前没有代码快照";
    elements.codeView.append(empty);
    elements.codeMeta.textContent = "尚无代码记录";
    elements.changeSummary.textContent = "尚未发生代码变化";
    elements.cursorPosition.textContent = "光标未记录";
    return;
  }

  const snapshot = data.code[codeIndex];
  const cursor = cursorIndex >= 0 ? data.cursor[cursorIndex] : null;
  const changeByLine = new Map();
  const counts = { add: 0, modify: 0, delete: 0 };
  const changedLines = { add: [], modify: [], delete: [] };
  snapshot.changes.forEach((change) => {
    const type = classifyChange(change);
    if (type !== "none") {
      changeByLine.set(change.line, type);
      counts[type] += 1;
      changedLines[type].push(change.line + 1);
    }
  });

  const lines = snapshot.code.replaceAll("\r\n", "\n").split("\n");
  const fragment = document.createDocumentFragment();
  lines.forEach((line, lineIndex) => {
    const row = document.createElement("div");
    row.className = "code-line";
    const change = changeByLine.get(lineIndex);
    if (change) row.classList.add(`change-${change}`);
    if (cursor && cursor.line === lineIndex) row.classList.add("is-cursor");

    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = String(lineIndex + 1);
    const marker = document.createElement("span");
    marker.className = "change-mark";
    const code = document.createElement("pre");
    code.textContent = line || " ";
    row.append(number, marker, code);
    fragment.append(row);
  });
  elements.codeView.append(fragment);

  elements.codeMeta.textContent = `${lines.length} 行 · 快照 ${codeIndex + 1}/${data.code.length}`;
  const formatChange = (label, type) => {
    const lines = [...new Set(changedLines[type])];
    const positions = lines.length
      ? `（行 ${lines.slice(0, 6).join("、")}${lines.length > 6 ? "…" : ""}）`
      : "";
    return `${label} ${counts[type]}${positions}`;
  };
  elements.changeSummary.textContent = `${snapshot.paste ? "粘贴操作" : "本次变化"} · ${formatChange(
    "新增",
    "add",
  )} · ${formatChange("修改", "modify")} · ${formatChange("删除", "delete")}`;
  elements.cursorPosition.textContent = cursor
    ? `文本光标：${cursor.line + 1}:${cursor.column + 1}`
    : "光标未记录";

  if (cursor) {
    const cursorRow = elements.codeView.querySelector(".is-cursor");
    cursorRow?.scrollIntoView({ block: "nearest" });
  }
}

function appendMessage(kind, label, time, body) {
  const wrapper = document.createElement("article");
  wrapper.className = `message ${kind}`;
  const meta = document.createElement("div");
  meta.className = "message-label";
  const name = document.createElement("span");
  name.textContent = label;
  const clock = document.createElement("time");
  clock.textContent = clockFormat.format(new Date(time));
  const content = document.createElement("div");
  content.className = "message-body";
  content.textContent = body;
  meta.append(name, clock);
  wrapper.append(meta, content);
  elements.aiMessages.append(wrapper);
}

function renderAI(force = false) {
  const visibleQuestions = state.studentData.ai.filter((item) => item.questionT <= state.current);
  const visibleReplies = visibleQuestions.filter((item) => item.replyT <= state.current).length;
  const cacheKey = `${visibleQuestions.length}:${visibleReplies}`;
  if (!force && state.renderCache.ai === cacheKey) return;
  state.renderCache.ai = cacheKey;
  elements.aiMessages.replaceChildren();

  if (!visibleQuestions.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.studentData.ai.length ? "当前时间点之前没有 AI 对话" : "该学生没有可关联的 AI 对话";
    elements.aiMessages.append(empty);
  } else {
    visibleQuestions.forEach((item) => {
      appendMessage("user", "学生提问", item.questionT, item.question);
      if (item.replyT <= state.current) {
        appendMessage("ai", "AI 回复", item.replyT, item.reply);
      } else {
        const waiting = document.createElement("span");
        waiting.className = "waiting-reply";
        waiting.textContent = "等待 AI 回复记录…";
        elements.aiMessages.append(waiting);
      }
    });
    elements.aiMessages.scrollTop = elements.aiMessages.scrollHeight;
  }
  elements.aiMeta.textContent = `${visibleQuestions.length}/${state.studentData.ai.length} 组对话已发生`;
}

function codeEventLabel(item) {
  const counts = { add: 0, modify: 0, delete: 0 };
  item.changes.forEach((change) => {
    const kind = classifyChange(change);
    if (kind in counts) counts[kind] += 1;
  });
  const parts = [];
  if (counts.add) parts.push(`新增 ${counts.add}`);
  if (counts.modify) parts.push(`修改 ${counts.modify}`);
  if (counts.delete) parts.push(`删除 ${counts.delete}`);
  return `${item.paste ? "粘贴代码" : "编辑代码"}${parts.length ? ` · ${parts.join(" / ")}` : ""}`;
}

function buildTimelineEvents(data) {
  const events = [];
  data.code.forEach((item) => events.push({ t: item.t, kind: "code", label: codeEventLabel(item) }));
  data.actions.forEach((item) =>
    events.push({
      t: item.t,
      kind: "action",
      label: item.type === "tab-switch" ? `切换页签：${item.label}` : `操作：${item.label}`,
    }),
  );
  data.status.forEach((item) =>
    events.push({ t: item.t, kind: "status", label: item.status === "online" ? "上线记录" : "离线记录" }),
  );
  data.ai.forEach((item) => {
    events.push({ t: item.questionT, kind: "ai", label: "发送 AI 问题" });
    events.push({ t: item.replyT, kind: "ai", label: "收到 AI 回复" });
  });
  return events.sort((a, b) => a.t - b.t);
}

function renderActivity() {
  const index = lastIndexAt(state.timelineEvents, state.current);
  const visible = index < 0 ? [] : state.timelineEvents.slice(Math.max(0, index - 8), index + 1).reverse();
  elements.activityList.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前时间点之前没有活动";
    elements.activityList.append(empty);
    return;
  }
  visible.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `activity-item ${item.kind}`;
    button.addEventListener("click", () => seek(item.t));
    const time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = clockFormat.format(new Date(item.t));
    const dot = document.createElement("i");
    dot.className = "activity-dot";
    const label = document.createElement("span");
    label.className = "activity-label";
    label.textContent = item.label;
    button.append(time, dot, label);
    elements.activityList.append(button);
  });
}

function renderVerification() {
  const statusElements = {
    "Vis Result": elements.previewStatus,
    Data: elements.dataStatus,
    PDF: elements.pdfStatus,
  };
  elements.verificationItems.forEach((button) => {
    const label = button.dataset.actionLabel;
    const actions = state.studentData.actions.filter((item) => item.label === label && item.t <= state.current);
    const latest = actions.at(-1);
    const status = statusElements[label];
    button.classList.toggle("has-events", Boolean(latest));
    button.disabled = !latest;
    button.dataset.latestTime = latest ? String(latest.t) : "";
    status.textContent = latest
      ? `已打开 ${actions.length} 次 · 最近 ${clockFormat.format(new Date(latest.t))}`
      : "当前时间点之前尚未打开";
  });
}

function renderMarkers() {
  elements.markerLane.replaceChildren();
  const duration = Math.max(1, state.studentData.timelineEnd - state.studentData.timelineStart);
  const fragment = document.createDocumentFragment();
  state.timelineEvents.forEach((event) => {
    const marker = document.createElement("i");
    marker.className = `marker ${event.kind}`;
    marker.style.left = `${((event.t - state.studentData.timelineStart) / duration) * 100}%`;
    fragment.append(marker);
  });
  elements.markerLane.append(fragment);
}

function renderState(force = false) {
  if (!state.studentData) return;
  renderStatus();
  renderCode(force);
  renderAI(force);
  renderActivity();
  renderVerification();
  updateTimelineControl();
}

async function loadStudent(studentMeta) {
  setPlaying(false);
  elements.shell.setAttribute("aria-busy", "true");
  elements.dataNote.textContent = "正在读取学生回放数据…";
  const response = await fetch(`/${studentMeta.file}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`学生数据读取失败：${response.status}`);
  state.studentData = await response.json();
  state.timelineEvents = buildTimelineEvents(state.studentData);
  state.current = state.studentData.timelineStart;
  state.renderCache = {};
  elements.timeline.max = String(Math.max(1, state.studentData.timelineEnd - state.studentData.timelineStart));
  elements.timeline.value = "0";
  renderMarkers();
  renderState(true);
  const counts = state.studentData.counts;
  elements.dataNote.textContent = `真实记录：代码 ${counts.code} · 光标 ${counts.cursor} · AI ${counts.ai} · 操作 ${counts.actions}`;
  elements.shell.setAttribute("aria-busy", "false");
}

function selectedGroup() {
  return state.index.groups.find((group) => group.id === elements.group.value);
}

async function populateStudents(preferredId = "") {
  const group = selectedGroup();
  elements.student.replaceChildren();
  group.students.forEach((student) => {
    const option = document.createElement("option");
    option.value = student.id;
    option.textContent = `${student.name} · 代码 ${student.counts.code}`;
    elements.student.append(option);
  });
  const preferred = group.students.find((student) => student.id === preferredId) || group.students[0];
  elements.student.value = preferred.id;
  await loadStudent(preferred);
}

async function initialize() {
  const response = await fetch("/data/index.json", { cache: "no-store" });
  if (!response.ok) throw new Error("回放索引不存在，请先运行 build_data.py");
  state.index = await response.json();
  state.index.groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${group.name} · ${group.students.length} 名学生`;
    elements.group.append(option);
  });
  elements.group.value = state.index.default.groupId || state.index.groups[0].id;
  await populateStudents(state.index.default.studentId);
}

elements.group.addEventListener("change", () => populateStudents().catch(showError));
elements.student.addEventListener("change", () => {
  const meta = selectedGroup().students.find((student) => student.id === elements.student.value);
  loadStudent(meta).catch(showError);
});
elements.play.addEventListener("click", () => setPlaying(!state.playing));
elements.restart.addEventListener("click", () => {
  if (state.studentData) seek(state.studentData.timelineStart);
});
elements.speed.addEventListener("change", () => {
  state.speed = Number(elements.speed.value);
});
elements.timeline.addEventListener("input", () => {
  if (!state.studentData) return;
  seek(state.studentData.timelineStart + Number(elements.timeline.value));
});
elements.verificationItems.forEach((button) => {
  button.addEventListener("click", () => {
    const latestTime = Number(button.dataset.latestTime);
    if (latestTime) seek(latestTime);
  });
});
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !["SELECT", "INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    setPlaying(!state.playing);
  }
});

function showError(error) {
  console.error(error);
  setPlaying(false);
  elements.shell.setAttribute("aria-busy", "false");
  elements.dataNote.textContent = error.message;
  elements.codeView.replaceChildren();
  const message = document.createElement("div");
  message.className = "empty-state";
  message.textContent = error.message;
  elements.codeView.append(message);
}

initialize().catch(showError);
