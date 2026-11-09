const state = { groups: [], selected: "", sort: "interest" };
const el = {
  main: document.querySelector("#findingsMain"),
  summary: document.querySelector("#summary"),
  list: document.querySelector("#groupList"),
  detailTitle: document.querySelector("#detailTitle"),
  detailMeta: document.querySelector("#detailMeta"),
  detailReplay: document.querySelector("#detailReplay"),
  detail: document.querySelector("#detailView"),
  sort: document.querySelector("#sortSelect"),
};

function count(items, predicate = () => true) { return items.filter(predicate).length; }
function percent(value, total) { return total ? `${(value / total * 100).toFixed(1)}%` : "0%"; }
function actorName(id) { return id || "未知成员"; }

function prepareGroup(group, analysis) {
  const participation = analysis.participation || [];
  const totalEvents = participation.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const lead = [...participation].sort((a, b) => b.total - a.total)[0];
  const codeLead = [...participation].sort((a, b) => b.finalCodeLines - a.finalCodeLines)[0];
  const noteLead = [...participation].sort((a, b) => b.finalNoteLines - a.finalNoteLines)[0];
  const aiLead = [...participation].sort((a, b) => b.counts.chat + b.counts.code - (a.counts.chat + a.counts.code))[0];
  const passive = Number(analysis.icapWindows?.filter((item) => item.level === "Passive").length || 0);
  const active = Number(analysis.icapWindows?.filter((item) => item.level === "Active").length || 0);
  const flags = [];
  if (!group.counts.completion) flags.push("未完成记录");
  if (lead && lead.total / Math.max(1, totalEvents) >= 0.8) flags.push("参与高度集中");
  else if (lead && lead.total / Math.max(1, totalEvents) >= 0.6) flags.push("存在主导成员");
  if (group.counts.aiQuestions >= 8) flags.push("AI互动密集");
  if (!group.counts.aiQuestions) flags.push("未记录AI提问");
  if (!group.counts.notes) flags.push("无共享笔记");
  if (group.counts.noteImages >= 200) flags.push("图片型笔记突出");
  if (codeLead?.id !== noteLead?.id && codeLead?.finalCodeLines > 0 && noteLead?.finalNoteLines > 0) flags.push("代码/笔记角色分化");
  let finding = "成员参与和产物贡献较分散，适合继续结合时间线观察接力和知识共享。";
  if (!group.counts.completion) finding = "这是唯一没有任务完成记录的小组，同时没有共享笔记和AI提问，适合研究低产出或中断过程。";
  else if (group.counts.aiQuestions >= 8 && lead?.total / Math.max(1, totalEvents) >= 0.8) finding = `${lead.id}集中承担主要操作并发起大部分AI提问，适合研究AI互动与单人主导、成员边缘参与之间的关系。`;
  else if (group.counts.noteImages >= 200) finding = `共享笔记包含${group.counts.noteImages}张图片，适合研究图像证据、文本记录和协作知识整理之间的关系。`;
  else if (codeLead?.id !== noteLead?.id && codeLead?.finalCodeLines > 0 && noteLead?.finalNoteLines > 0) finding = `最终代码主要归属于${codeLead.id}，最终笔记主要归属于${noteLead.id}，适合研究代码执行与知识整理的角色分工。`;
  else if (group.counts.aiQuestions === 0) finding = "没有记录到AI提问，但仍有代码、笔记或聊天活动，适合与AI密集小组进行对照。";
  return { ...group, analysis, participation, totalEvents, lead, codeLead, noteLead, aiLead, passive, active, flags, finding, interest: flags.length * 3 + (group.counts.aiQuestions >= 8 ? 4 : 0) + (group.counts.noteImages >= 200 ? 3 : 0) + (!group.counts.completion ? 5 : 0) };
}

function renderSummary() {
  const totalAI = state.groups.reduce((sum, item) => sum + item.counts.aiQuestions, 0);
  const completed = state.groups.filter((item) => item.counts.completion > 0).length;
  const imageCount = state.groups.reduce((sum, item) => sum + item.counts.noteImages, 0);
  const cards = [[state.groups.length, "小组", "每组3名成员"], [completed, "有完成记录", `${state.groups.length - completed}组没有完成记录`], [totalAI, "AI提问", "原始聊天中的明确@AI问题"], [imageCount, "笔记图片", "图片快照去重前的记录数"], [state.groups.filter((item) => item.interest >= 8).length, "重点候选组", "按规则筛选，需回放复核"]];
  el.summary.replaceChildren(...cards.map(([value, label, detail]) => { const box = document.createElement("div"); box.className = "summary-card"; box.innerHTML = `<strong>${value}</strong><span>${label}</span><small>${detail}</small>`; return box; }));
}

function renderList() {
  const sorted = [...state.groups].sort((a, b) => {
    if (state.sort === "ai") return b.counts.aiQuestions - a.counts.aiQuestions;
    if (state.sort === "events") return b.totalEvents - a.totalEvents;
    if (state.sort === "images") return b.counts.noteImages - a.counts.noteImages;
    if (state.sort === "completion") return b.counts.completion - a.counts.completion || b.interest - a.interest;
    return b.interest - a.interest || b.totalEvents - a.totalEvents;
  });
  el.list.replaceChildren(...sorted.map((item) => {
    const button = document.createElement("button"); button.type = "button"; button.className = `group-card ${item.groupId === state.selected ? "is-selected" : ""}`;
    const title = document.createElement("strong"); title.textContent = item.groupId;
    const body = document.createElement("div"); body.className = "group-finding"; body.textContent = item.finding;
    const stats = document.createElement("div"); stats.className = "group-stats"; stats.innerHTML = `<span>AI ${item.counts.aiQuestions}</span><span>代码 ${item.counts.code}</span><span>笔记 ${item.counts.notes}</span><span>图片 ${item.counts.noteImages}</span>`; body.append(stats);
    const badge = document.createElement("span"); badge.className = "interest-badge"; badge.textContent = item.flags.slice(0, 2).join(" · ") || "常规对照";
    button.append(title, body, badge); button.addEventListener("click", () => { state.selected = item.groupId; renderList(); renderDetail(); }); return button;
  }));
}

function bar(value, total, color) { const wrap = document.createElement("div"); wrap.className = "mini-bar"; const fill = document.createElement("i"); fill.style.width = percent(value, total); fill.style.setProperty("--bar-color", color); wrap.append(fill); return wrap; }

function renderDetail() {
  const item = state.groups.find((group) => group.groupId === state.selected) || state.groups[0];
  if (!item) return;
  state.selected = item.groupId; el.detailTitle.textContent = `${item.groupId} · 小组详情`; el.detailMeta.textContent = `${item.totalEvents.toLocaleString("zh-CN")} 条成员行为记录 · ${item.analysis.icapWindows?.length || 0} 个后期分析窗口`; el.detailReplay.href = `/?group=${encodeURIComponent(item.groupId)}`;
  const metrics = [[item.totalEvents.toLocaleString("zh-CN"), "成员行为"], [item.counts.aiQuestions, "AI提问"], [item.counts.noteImages, "笔记图片"], [item.counts.completion ? "有" : "无", "完成记录"]];
  el.detail.replaceChildren(); const lead = document.createElement("div"); lead.className = "detail-lead"; lead.append(...metrics.map(([value, label]) => { const box = document.createElement("div"); box.className = "detail-metric"; box.innerHTML = `<strong>${value}</strong><span>${label}</span>`; return box; })); el.detail.append(lead);
  const memberSection = document.createElement("section"); memberSection.className = "detail-section"; memberSection.innerHTML = "<h3>成员行为分布</h3>";
  const table = document.createElement("table"); table.className = "member-table"; table.innerHTML = "<thead><tr><th>成员</th><th>总行为</th><th>代码/笔记</th><th>聊天/AI</th><th>页面操作</th></tr></thead>"; const tbody = document.createElement("tbody");
  item.participation.forEach((person) => { const row = document.createElement("tr"); const name = document.createElement("td"); name.className = "member-name"; name.style.setProperty("--member-color", person.color); name.textContent = actorName(person.id); const total = document.createElement("td"); total.append(bar(person.total, item.totalEvents, person.color), document.createTextNode(`${person.total} · ${percent(person.total, item.totalEvents)}`)); const artifact = document.createElement("td"); artifact.textContent = `${person.counts.code}/${person.counts.notes}`; const chat = document.createElement("td"); const aiQuestions = count(item.chat, (message) => message.kind === "ai-question" && message.actor === person.id); chat.textContent = `${person.counts.chat}/${aiQuestions}`; const actions = document.createElement("td"); actions.textContent = String(person.counts.actions); row.append(name,total,artifact,chat,actions); tbody.append(row); }); table.append(tbody); memberSection.append(table); el.detail.append(memberSection);
  const findingSection = document.createElement("section"); findingSection.className = "detail-section"; findingSection.innerHTML = "<h3>可分析发现</h3>"; const mainFinding = document.createElement("div"); mainFinding.className = "detail-finding"; mainFinding.innerHTML = `<strong>候选发现：</strong>${item.finding}`; findingSection.append(mainFinding); item.flags.forEach((flag) => { const line = document.createElement("div"); line.className = "detail-finding"; line.textContent = flag; findingSection.append(line); }); const note = document.createElement("p"); note.className = "detail-note"; note.textContent = `代码主导：${item.codeLead?.id || "无"}；笔记主导：${item.noteLead?.id || "无"}；自动分析窗口：Passive ${item.passive}、Active ${item.active}。以上只用于筛查，点击“打开该组回放”核对具体时间线。`; findingSection.append(note); el.detail.append(findingSection);
}

async function initialize() {
  const index = await (await fetch("/data/index.json", { cache: "no-store" })).json();
  const records = await Promise.all(index.groups.map(async (meta) => { const group = await (await fetch(`/${meta.file}`, { cache: "no-store" })).json(); const analysis = await (await fetch(`/data/analysis/${meta.id}.json`, { cache: "no-store" })).json(); return prepareGroup(group, analysis); }));
  state.groups = records; state.selected = new URLSearchParams(window.location.search).get("group") || records[0]?.groupId || ""; if (!records.some((item) => item.groupId === state.selected)) state.selected = records[0]?.groupId || ""; renderSummary(); renderList(); renderDetail(); el.main.setAttribute("aria-busy", "false");
}

el.sort.addEventListener("change", () => { state.sort = el.sort.value; renderList(); });
initialize().catch((error) => { console.error(error); el.main.setAttribute("aria-busy", "false"); el.detail.innerHTML = `<div class="empty-state">读取小组分析失败：${error.message}</div>`; });
