const state = {
  index: null,
  group: null,
  current: 0,
  events: [],
  playing: false,
  speed: 60,
  frame: 0,
  lastFrameAt: 0,
  cache: {},
  context: "notes",
};

const el = {
  shell: document.querySelector("#replayShell"),
  group: document.querySelector("#groupSelect"),
  members: document.querySelector("#memberLegend"),
  analysisLink: document.querySelector("#analysisLink"),
  codePanel: document.querySelector("#codePanel"),
  codeMeta: document.querySelector("#codeMeta"),
  codeActor: document.querySelector("#codeActor"),
  changeSummary: document.querySelector("#changeSummary"),
  cursorSummary: document.querySelector("#cursorSummary"),
  codeView: document.querySelector("#codeView"),
  notesPane: document.querySelector("#notesPane"),
  noteMeta: document.querySelector("#noteMeta"),
  noteActor: document.querySelector("#noteActor"),
  noteView: document.querySelector("#noteView"),
  chatMeta: document.querySelector("#chatMeta"),
  chatMessages: document.querySelector("#chatMessages"),
  contextTabs: [...document.querySelectorAll(".context-tab")],
  contextPanes: [...document.querySelectorAll("[data-context-pane]")],
  activity: document.querySelector("#activityList"),
  completion: document.querySelector("#completionStatus"),
  actionSummary: document.querySelector("#actionSummary"),
  markerLegend: document.querySelector("#markerLegend"),
  markerLane: document.querySelector("#markerLane"),
  timeline: document.querySelector("#timeline"),
  play: document.querySelector("#playButton"),
  restart: document.querySelector("#restartButton"),
  speed: document.querySelector("#speedSelect"),
  currentTime: document.querySelector("#currentTime"),
  elapsed: document.querySelector("#elapsedTime"),
  dataNote: document.querySelector("#dataNote"),
};

const clockFormat = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTimeFormat = new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const ACTION_NAMES = {
  "Vis Result": "结果页",
  Data: "数据页",
  PDF: "PDF",
  Send: "发送消息",
  "Mention Click": "点击提及",
  "Image Upload": "上传图片",
  "Complete Task": "完成任务",
};

function lastIndexAt(items, time, field = "t") {
  let low = 0;
  let high = items.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (items[middle][field] <= time) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
}

function latestAt(items, time) {
  const index = lastIndexAt(items, time);
  return index >= 0 ? items[index] : null;
}

function durationText(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function member(actor) {
  return state.group?.members.find((item) => item.id === actor);
}

function actorColor(actor) {
  if (actor === "AI") return "#f4b6d2";
  return member(actor)?.color || "#ecefed";
}

function setActorStyle(node, actor) {
  node.style.setProperty("--actor-color", actorColor(actor));
}

function displayActor(actor) {
  return actor === "AI" ? "AI 助手" : actor || "系统";
}

function classifyChange(change) {
  if (!change.old && change.new) return "add";
  if (change.old && !change.new) return "delete";
  return "modify";
}

function empty(container, text) {
  container.replaceChildren();
  const node = document.createElement("div");
  node.className = "empty-state";
  node.textContent = text;
  container.append(node);
}

function latestByActor(items, time) {
  const result = new Map();
  const end = lastIndexAt(items, time);
  for (let index = end; index >= 0; index -= 1) {
    const item = items[index];
    if (!result.has(item.actor)) result.set(item.actor, item);
    if (result.size >= state.group.members.length) break;
  }
  return result;
}

function renderMembers() {
  const statuses = latestByActor(state.group.status, state.current);
  const tabs = latestByActor(state.group.actions.filter((item) => item.type === "tab-switch"), state.current);
  el.members.replaceChildren();
  state.group.members.forEach((person) => {
    const status = statuses.get(person.id);
    const tab = tabs.get(person.id);
    const chip = document.createElement("span");
    chip.className = `member-chip ${status?.status === "online" ? "is-online" : ""}`;
    chip.style.setProperty("--actor-color", person.color);
    chip.title = `${person.id}${person.username ? `（${person.username}）` : ""}`;
    const dot = document.createElement("i");
    const name = document.createElement("strong");
    name.textContent = person.id;
    const detail = document.createElement("small");
    const statusText = status ? (status.status === "online" ? "在线记录" : "离线记录") : "状态未记录";
    detail.textContent = tab ? `${statusText} · ${ACTION_NAMES[tab.label] || tab.label}` : statusText;
    chip.append(dot, name, detail);
    el.members.append(chip);
  });
}

function currentCursors() {
  return latestByActor(state.group.cursor, state.current);
}

function renderCode(force = false) {
  const index = lastIndexAt(state.group.code, state.current);
  const snapshot = index >= 0 ? state.group.code[index] : null;
  const cursors = currentCursors();
  const cursorKey = [...cursors.values()].map((item) => `${item.actor}:${item.t}`).join("|");
  const key = `${index}:${cursorKey}`;
  if (!force && state.cache.code === key) return;
  state.cache.code = key;
  if (!snapshot) {
    el.codePanel.style.removeProperty("--actor-color");
    el.codePanel.style.background = "";
    el.codeActor.textContent = "尚无快照";
    el.codeActor.style.removeProperty("--actor-color");
    el.codeMeta.textContent = "当前时间点之前没有代码";
    el.changeSummary.textContent = "尚未发生代码变化";
    el.cursorSummary.textContent = cursors.size ? [...cursors.values()].map((item) => `${item.actor} ${item.line + 1}:${item.column + 1}`).join(" · ") : "文本光标未记录";
    empty(el.codeView, "代码会在第一条快照到达后出现");
    return;
  }

  const color = actorColor(snapshot.actor);
  el.codePanel.style.background = `linear-gradient(${color}88, ${color}88)`;
  setActorStyle(el.codeActor, snapshot.actor);
  el.codeActor.textContent = `${snapshot.actor} · ${snapshot.bulk ? "批量更新" : "编辑"}`;
  el.codeMeta.textContent = `快照 ${index + 1}/${state.group.code.length} · ${clockFormat.format(new Date(snapshot.t))}`;

  const changeCounts = { add: 0, modify: 0, delete: 0 };
  const changedLines = new Map();
  snapshot.changes.forEach((change) => {
    const kind = classifyChange(change);
    changeCounts[kind] += 1;
    changedLines.set(change.line, kind);
  });
  el.changeSummary.textContent = `新增 ${changeCounts.add} · 修改 ${changeCounts.modify} · 删除 ${changeCounts.delete}`;
  el.cursorSummary.textContent = cursors.size
    ? [...cursors.values()].map((item) => `${item.actor} ${item.line + 1}:${item.column + 1}`).join(" · ")
    : "文本光标未记录";

  const cursorsByLine = new Map();
  cursors.forEach((cursor) => {
    if (!cursorsByLine.has(cursor.line)) cursorsByLine.set(cursor.line, []);
    cursorsByLine.get(cursor.line).push(cursor);
  });
  const fragment = document.createDocumentFragment();
  const lines = snapshot.code.replaceAll("\r\n", "\n").split("\n");
  lines.forEach((line, lineIndex) => {
    const row = document.createElement("div");
    row.className = "code-line";
    const owner = snapshot.owners?.[lineIndex] || snapshot.actor;
    row.style.setProperty("--owner-color", actorColor(owner));
    row.dataset.owner = owner;
    row.title = `最后编辑：${displayActor(owner)}`;
    if (changedLines.has(lineIndex)) row.classList.add(`change-${changedLines.get(lineIndex)}`);
    const lineCursors = cursorsByLine.get(lineIndex) || [];
    if (lineCursors.length) {
      row.classList.add("has-cursor");
      row.style.setProperty("--cursor-color", actorColor(lineCursors[0].actor));
    }
    const number = document.createElement("span");
    number.className = "line-number";
    number.textContent = String(lineIndex + 1);
    const mark = document.createElement("i");
    mark.className = "change-mark";
    const code = document.createElement("pre");
    lineCursors.forEach((cursor) => {
      const tag = document.createElement("span");
      tag.className = "cursor-tag";
      tag.style.setProperty("--cursor-color", actorColor(cursor.actor));
      tag.textContent = `${cursor.actor} @${cursor.column + 1}`;
      code.append(tag);
    });
    code.append(document.createTextNode(line || " "));
    row.append(number, mark, code);
    fragment.append(row);
  });
  el.codeView.replaceChildren(fragment);
}

function renderNote(force = false) {
  const index = lastIndexAt(state.group.notes, state.current);
  if (!force && state.cache.note === index) return;
  state.cache.note = index;
  const snapshot = index >= 0 ? state.group.notes[index] : null;
  if (!snapshot) {
    el.notesPane.style.background = "";
    el.noteActor.textContent = "尚无快照";
    el.noteActor.style.removeProperty("--actor-color");
    el.noteMeta.textContent = "当前时间点之前没有笔记";
    empty(el.noteView, "共享笔记会在第一条快照到达后出现");
    return;
  }
  const color = actorColor(snapshot.actor);
  el.notesPane.style.background = `linear-gradient(${color}88, ${color}88)`;
  setActorStyle(el.noteActor, snapshot.actor);
  el.noteActor.textContent = `${snapshot.actor} · ${snapshot.bulk ? "批量更新" : "编辑"}`;
  el.noteMeta.textContent = `快照 ${index + 1}/${state.group.notes.length} · ${clockFormat.format(new Date(snapshot.t))}`;
  el.noteView.replaceChildren();
  const text = document.createElement("div");
  text.className = "note-text";
  const noteLines = (snapshot.text || "（该快照只有图片或空内容）").replaceAll("\r\n", "\n").split("\n");
  noteLines.forEach((line, lineIndex) => {
    const owner = snapshot.owners?.[lineIndex] || snapshot.actor;
    const row = document.createElement("div");
    row.className = "note-line";
    row.style.setProperty("--owner-color", actorColor(owner));
    row.dataset.owner = owner;
    row.title = `最后编辑：${displayActor(owner)}`;
    row.textContent = line || "\u00a0";
    text.append(row);
  });
  el.noteView.append(text);
  if (snapshot.images.length) {
    const gallery = document.createElement("div");
    gallery.className = "note-images";
    snapshot.images.forEach((path, imageIndex) => {
      const figure = document.createElement("figure");
      const owner = snapshot.imageOwners?.[imageIndex] || snapshot.actor;
      figure.style.setProperty("--owner-color", actorColor(owner));
      figure.title = `最后添加：${displayActor(owner)}`;
      const image = document.createElement("img");
      image.src = `/${path}`;
      image.alt = `笔记图片 ${imageIndex + 1}`;
      image.loading = "lazy";
      const caption = document.createElement("figcaption");
      caption.textContent = `笔记图片 ${imageIndex + 1} · ${displayActor(owner)}`;
      figure.append(image, caption);
      gallery.append(figure);
    });
    el.noteView.append(gallery);
  }
}

function renderChat(force = false) {
  const end = lastIndexAt(state.group.chat, state.current);
  if (!force && state.cache.chat === end) return;
  state.cache.chat = end;
  el.chatMessages.replaceChildren();
  if (end < 0) {
    el.chatMeta.textContent = "当前时间点之前没有消息";
    empty(el.chatMessages, "聊天和AI回复不会提前显示");
    return;
  }
  const fragment = document.createDocumentFragment();
  for (let index = 0; index <= end; index += 1) {
    const item = state.group.chat[index];
    const article = document.createElement("article");
    article.className = `message ${item.kind}`;
    setActorStyle(article, item.actor);
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const actor = document.createElement("strong");
    actor.textContent = `${displayActor(item.actor)}${item.kind === "ai-question" ? " · 提问AI" : item.kind === "ai-reply" ? " · AI回复" : ""}`;
    const time = document.createElement("time");
    time.textContent = clockFormat.format(new Date(item.t));
    meta.append(actor, time);
    const body = document.createElement("div");
    body.className = "message-body";
    body.textContent = item.message;
    article.append(meta, body);
    if (item.hasCode && item.code) {
      const code = document.createElement("pre");
      code.className = "message-code";
      code.textContent = item.code;
      article.append(code);
    }
    if (item.hasImage) {
      const attachment = document.createElement("div");
      attachment.className = "message-attachment";
      attachment.textContent = `图片消息${item.imageDescription ? `：${item.imageDescription}` : "（原始聊天图片未内嵌到轻量回放）"}`;
      article.append(attachment);
    }
    fragment.append(article);
  }
  el.chatMessages.append(fragment);
  el.chatMeta.textContent = `${end + 1}/${state.group.chat.length} 条已发生 · AI问题 ${state.group.chat.slice(0, end + 1).filter((item) => item.kind === "ai-question").length}`;
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function eventLabel(item) {
  if (item.kind === "code") return `${item.bulk ? "批量更新" : "编辑"}共享代码`;
  if (item.kind === "note") return `${item.bulk ? "批量更新" : "编辑"}共享笔记`;
  if (item.kind === "chat") {
    if (item.chatKind === "ai-question") return "向AI提问";
    if (item.chatKind === "ai-reply") return "AI回复";
    if (item.chatKind === "system") return "进入/离开房间消息";
    return "发送房间消息";
  }
  if (item.kind === "action") return ACTION_NAMES[item.label] || item.label || "页面操作";
  if (item.kind === "status") return item.status === "online" ? "上线记录" : "离线记录";
  if (item.kind === "completion") return "提交任务完成";
  return item.kind;
}

function buildEvents(group) {
  const events = [];
  group.code.forEach((item) => events.push({ ...item, kind: "code" }));
  group.notes.forEach((item) => events.push({ ...item, kind: "note" }));
  group.chat.forEach((item) => events.push({ ...item, kind: "chat", chatKind: item.kind }));
  group.actions.forEach((item) => events.push({ ...item, kind: "action" }));
  group.status.forEach((item) => events.push({ ...item, kind: "status" }));
  group.completion.forEach((item) => events.push({ ...item, kind: "completion" }));
  return events.sort((a, b) => a.t - b.t);
}

function renderActivity() {
  const end = lastIndexAt(state.events, state.current);
  const visible = end < 0 ? [] : state.events.slice(Math.max(0, end - 11), end + 1).reverse();
  el.activity.replaceChildren();
  if (!visible.length) {
    empty(el.activity, "当前时间点之前没有活动");
    return;
  }
  visible.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `activity-item ${item.kind}`;
    setActorStyle(button, item.actor);
    button.title = `${displayActor(item.actor)} · ${eventLabel(item)}`;
    button.addEventListener("click", () => seek(item.t));
    const time = document.createElement("span");
    time.className = "activity-time";
    time.textContent = clockFormat.format(new Date(item.t));
    const dot = document.createElement("i");
    dot.className = "activity-dot";
    const label = document.createElement("span");
    label.className = "activity-label";
    label.textContent = `${displayActor(item.actor)} · ${eventLabel(item)}`;
    button.append(time, dot, label);
    el.activity.append(button);
  });
}

function renderActions() {
  const visible = state.group.actions.filter((item) => item.t <= state.current);
  const labels = [...new Set(state.group.actions.map((item) => item.label))];
  el.actionSummary.replaceChildren();
  labels.forEach((label) => {
    const matching = visible.filter((item) => item.label === label);
    const latest = matching.at(-1);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `action-stat ${latest ? "has-events" : ""}`;
    button.disabled = !latest;
    if (latest) {
      setActorStyle(button, latest.actor);
      button.addEventListener("click", () => seek(latest.t));
    }
    const name = document.createElement("strong");
    name.textContent = ACTION_NAMES[label] || label;
    const detail = document.createElement("small");
    detail.textContent = latest ? `${matching.length}次 · ${latest.actor} ${clockFormat.format(new Date(latest.t))}` : "尚未发生";
    button.append(name, detail);
    el.actionSummary.append(button);
  });
  const completion = latestAt(state.group.completion, state.current);
  if (completion) {
    el.completion.textContent = `${completion.actor} 于 ${clockFormat.format(new Date(completion.t))} 完成`;
    el.completion.style.color = "var(--green)";
  } else {
    el.completion.textContent = state.group.completion.length ? "当前时间点尚未完成" : "该组没有完成记录";
    el.completion.style.color = "";
  }
}

function renderMarkers() {
  el.markerLane.replaceChildren();
  const duration = Math.max(1, state.group.timelineEnd - state.group.timelineStart);
  const fragment = document.createDocumentFragment();
  state.events.forEach((event) => {
    if (event.kind === "status") return;
    const marker = document.createElement("i");
    marker.className = `marker ${event.kind}`;
    marker.style.left = `${((event.t - state.group.timelineStart) / duration) * 100}%`;
    marker.style.setProperty("--actor-color", actorColor(event.actor));
    marker.style.setProperty("--marker-height", `${event.kind === "code" ? 17 : event.kind === "note" ? 12 : event.kind === "chat" ? 9 : 6}px`);
    fragment.append(marker);
  });
  el.markerLane.append(fragment);
}

function updateTimeline() {
  const start = state.group.timelineStart;
  const end = state.group.timelineEnd;
  el.timeline.value = String(Math.max(0, Math.round(state.current - start)));
  el.currentTime.textContent = clockFormat.format(new Date(state.current));
  el.elapsed.textContent = `${durationText(state.current - start)} / ${durationText(end - start)}`;
}

function render(force = false) {
  if (!state.group) return;
  renderMembers();
  renderCode(force);
  renderNote(force);
  renderChat(force);
  renderActivity();
  renderActions();
  updateTimeline();
}

function seek(time) {
  if (!state.group) return;
  state.current = Math.max(state.group.timelineStart, Math.min(state.group.timelineEnd, time));
  render();
}

function frame(now) {
  if (!state.playing) return;
  if (!state.lastFrameAt) state.lastFrameAt = now;
  const delta = now - state.lastFrameAt;
  state.lastFrameAt = now;
  const next = state.current + delta * state.speed;
  if (next >= state.group.timelineEnd) {
    seek(state.group.timelineEnd);
    setPlaying(false);
    return;
  }
  seek(next);
  state.frame = requestAnimationFrame(frame);
}

function setPlaying(value) {
  state.playing = value;
  state.lastFrameAt = 0;
  el.play.textContent = value ? "❚❚" : "▶";
  el.play.title = value ? "暂停" : "播放";
  el.play.setAttribute("aria-label", value ? "暂停" : "播放");
  cancelAnimationFrame(state.frame);
  if (value) state.frame = requestAnimationFrame(frame);
}

function renderLegends() {
  el.markerLegend.replaceChildren();
  state.group.members.forEach((person) => {
    const item = document.createElement("span");
    item.style.setProperty("--actor-color", person.color);
    const swatch = document.createElement("i");
    const name = document.createTextNode(person.id);
    item.append(swatch, name);
    el.markerLegend.append(item);
  });
  const ai = document.createElement("span");
  ai.style.setProperty("--actor-color", "#f4b6d2");
  const aiSwatch = document.createElement("i");
  ai.append(aiSwatch, document.createTextNode("AI"));
  el.markerLegend.append(ai);
}

function archiveClassification(file) {
  const map = {
    "rooms.csv": ["核心/组级", "成员名单与共享对象终态；用于建立小组和成员颜色。"],
    "codehistories.csv": ["实时回放", "完整共享代码快照、变化行、操作者和批量更新标记。"],
    "notehistories.csv": ["实时回放", "完整共享笔记快照；HTML已转为文本，内嵌图片按内容去重。"],
    "cursorpositions.csv": ["实时回放", "编辑器文本光标与选区；不是鼠标屏幕坐标。"],
    "useractions.csv": ["实时回放", "结果页、数据、PDF、发送、提及、图片上传和完成按钮操作。"],
    "chatmessages.csv": ["实时回放", "组级普通聊天、AI问题、AI回复及回复关联。"],
    "taskcompletions.csv": ["实时回放", "任务完成时间、完成人及最终代码/笔记长度。"],
    "events.csv": ["统一事件/状态", "统一事件表；本系统从中恢复成员online/offline连接状态。"],
    "users.csv": ["身份登记", "用户登记信息；回放采用匿名成员名，不额外展示真实身份。"],
    "ai_chat_analysis.csv": ["后期分析", "AI问答配对与内容分析；实时消息直接取原始chatmessages。"],
    "ai_interaction_analysis.csv": ["后期分析", "AI交互的事后特征，不作为学生当时看到的内容。"],
    "analysis_results.csv": ["后期分析", "活动结束后的窗口分析，不能混入7月15日实时轴。"],
    "comprehensive_analysis_results.csv": ["后期分析", "事后ICAP与协作分析；这里只显示聚合摘要并保留兼容性警告。"],
    "sampled_notes.csv": ["后期抽样", "为离线分析抽取的笔记样本，原始笔记回放已覆盖其内容。"],
    "sampled_notes_analysis.csv": ["后期分析", "抽样笔记的自动分析，不是学生实时行为。"],
    "note_analysis_results.csv": ["后期分析", "笔记结果分析，不是实时事件。"],
    "message_history.csv": ["研究仪表盘", "2025年8-9月教师/研究仪表盘截图历史，不是学生聊天。"],
    "message_history_1.csv": ["研究仪表盘", "教师/研究仪表盘截图历史，不进入学生回放。"],
    "message_history_2.csv": ["研究仪表盘", "教师/研究仪表盘截图历史，不进入学生回放。"],
    "analysis_status.csv": ["流程状态", "后期分析任务状态，不是学习行为。"],
    "timeline_analysis.csv": ["空文件", "0行，没有可显示的记录。"],
  };
  return map[file] || ["源数据", "保留在数据档案中，未识别为实时回放事件。"];
}

function renderArchive() {
  el.archiveContent.replaceChildren();
  const totals = state.index.totals;
  const summary = document.createElement("div");
  summary.className = "archive-summary";
  [["小组", state.index.groups.length], ["成员", state.index.groups.reduce((sum, group) => sum + group.members.length, 0)], ["代码快照", totals.code], ["笔记快照", totals.notes], ["房间消息", totals.chat], ["去重笔记图片", state.index.assetCount]].forEach(([label, value]) => {
    const box = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    box.append(strong, span);
    summary.append(box);
  });
  el.archiveContent.append(summary);

  const warning = document.createElement("div");
  warning.className = "archive-warning";
  const icap = Object.entries(state.group.posthoc.icap).map(([key, value]) => `${key} ${value}`).join("、") || "无";
  warning.textContent = `当前组后期综合分析：${state.group.posthoc.windows}个窗口，ICAP聚合为 ${icap}。${state.group.posthoc.warning} ${state.group.limitations.ownership} 数据没有终端、测试结果、鼠标坐标、页面可见性或消息已读信息。`;
  el.archiveContent.append(warning);

  const section = document.createElement("section");
  section.className = "archive-section";
  const title = document.createElement("h3");
  title.textContent = "源文件逐项说明";
  const table = document.createElement("table");
  table.className = "archive-table";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["文件", "行数", "类别", "在系统中的用途或未直接使用原因"].forEach((label) => {
    const th = document.createElement("th");
    th.textContent = label;
    headRow.append(th);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  state.index.manifest.forEach((item) => {
    const [category, reason] = archiveClassification(item.file);
    const row = document.createElement("tr");
    [item.file, item.rows.toLocaleString("zh-CN"), category, reason].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      row.append(td);
    });
    body.append(row);
  });
  table.append(head, body);
  section.append(title, table);
  el.archiveContent.append(section);
}

function setContext(name) {
  state.context = name;
  el.contextTabs.forEach((tab) => {
    const active = tab.dataset.context === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  el.contextPanes.forEach((pane) => pane.classList.toggle("is-active", pane.dataset.contextPane === name));
}

async function loadGroup(meta) {
  setPlaying(false);
  el.shell.setAttribute("aria-busy", "true");
  el.dataNote.textContent = "正在读取小组联合回放…";
  const response = await fetch(`/${meta.file}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`小组数据读取失败：${response.status}`);
  state.group = await response.json();
  el.analysisLink.href = `/app/analysis.html?group=${encodeURIComponent(state.group.groupId)}`;
  state.events = buildEvents(state.group);
  state.current = state.group.timelineStart;
  state.cache = {};
  el.timeline.max = String(Math.max(1, state.group.timelineEnd - state.group.timelineStart));
  el.timeline.value = "0";
  renderLegends();
  renderMarkers();
  render(true);
  const c = state.group.counts;
  el.dataNote.textContent = `真实记录：代码 ${c.code} · 笔记 ${c.notes} · 光标 ${c.cursor} · 消息 ${c.chat} · AI ${c.aiQuestions}/${c.aiReplies} · 操作 ${c.actions}`;
  el.shell.setAttribute("aria-busy", "false");
}

async function initialize() {
  const response = await fetch("/data/index.json", { cache: "no-store" });
  if (!response.ok) throw new Error("回放索引不存在，请先运行 build_data.py");
  state.index = await response.json();
  state.index.groups.forEach((group) => {
    const option = document.createElement("option");
    option.value = group.id;
    option.textContent = `${group.name} · ${group.members.length}人`;
    el.group.append(option);
  });
  const requestedGroup = new URLSearchParams(window.location.search).get("group");
  el.group.value = state.index.groups.some((group) => group.id === requestedGroup)
    ? requestedGroup
    : state.index.defaultGroup || state.index.groups[0].id;
  await loadGroup(state.index.groups.find((group) => group.id === el.group.value));
  setContext("notes");
}

el.group.addEventListener("change", () => loadGroup(state.index.groups.find((group) => group.id === el.group.value)).catch(showError));
el.play.addEventListener("click", () => setPlaying(!state.playing));
el.restart.addEventListener("click", () => state.group && seek(state.group.timelineStart));
el.speed.addEventListener("change", () => { state.speed = Number(el.speed.value); });
el.timeline.addEventListener("input", () => state.group && seek(state.group.timelineStart + Number(el.timeline.value)));
el.contextTabs.forEach((tab) => tab.addEventListener("click", () => setContext(tab.dataset.context)));
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !["SELECT", "INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) {
    event.preventDefault();
    setPlaying(!state.playing);
  }
});

function showError(error) {
  console.error(error);
  setPlaying(false);
  el.shell.setAttribute("aria-busy", "false");
  el.dataNote.textContent = error.message;
  empty(el.codeView, error.message);
}

initialize().catch(showError);
