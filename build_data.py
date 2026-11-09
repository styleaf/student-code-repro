#!/usr/bin/env python3
"""Build group-level replay data from the exported CSV snapshot."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import html
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path


LOCAL_TZ = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = ROOT.parent / "prodai_local_20260924"
DEFAULT_OUTPUT = ROOT / "data"
MEMBER_COLORS = ["#b7d7ff", "#aee9c1", "#f4d77a", "#d7c6f4"]
DATA_IMAGE_RE = re.compile(
    r"data:(image/(?P<kind>png|jpeg|jpg|gif|webp));base64,(?P<data>[A-Za-z0-9+/=\r\n]+)",
    re.IGNORECASE,
)


def parse_time(value: str) -> int:
    text = (value or "").strip()
    if not text:
        return 0
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=LOCAL_TZ)
    return round(parsed.timestamp() * 1000)


def parse_json(value: str, fallback: object) -> object:
    try:
        return json.loads(value) if value else fallback
    except (json.JSONDecodeError, TypeError):
        return fallback


def parse_bool(value: str) -> bool:
    return (value or "").strip().lower() == "true"


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


class NoteTextParser(HTMLParser):
    BREAK_TAGS = {"br", "div", "p", "li", "h1", "h2", "h3", "h4", "pre", "tr"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.BREAK_TAGS and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")
        if tag == "li":
            self.parts.append("- ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.BREAK_TAGS and self.parts and not self.parts[-1].endswith("\n"):
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def text(self) -> str:
        value = "".join(self.parts).replace("\xa0", " ")
        value = re.sub(r"[ \t]+\n", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return html.unescape(value).strip()


def clean_note(raw: str, assets_dir: Path, asset_cache: dict[str, str]) -> tuple[str, list[str]]:
    images: list[str] = []

    def extract(match: re.Match[str]) -> str:
        try:
            blob = base64.b64decode(re.sub(r"\s+", "", match.group("data")), validate=False)
        except (ValueError, base64.binascii.Error):
            return "[无法解析的内嵌图片]"
        digest = hashlib.sha256(blob).hexdigest()[:20]
        ext = "jpg" if match.group("kind").lower() in {"jpeg", "jpg"} else match.group("kind").lower()
        relative = asset_cache.get(digest)
        if not relative:
            filename = f"note-{digest}.{ext}"
            (assets_dir / filename).write_bytes(blob)
            relative = f"data/assets/{filename}"
            asset_cache[digest] = relative
        if relative not in images:
            images.append(relative)
        return "[笔记图片]"

    without_images = DATA_IMAGE_RE.sub(extract, raw or "")
    parser = NoteTextParser()
    try:
        parser.feed(without_images)
        text = parser.text()
    except Exception:
        text = re.sub(r"<[^>]+>", " ", without_images)
        text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    return text, images


def normalized_provenance_text(value: str) -> str:
    return re.sub(r"\s+", "", value or "").lower()


def add_content_owners(snapshots: list[dict], content_key: str, chat: list[dict], min_ai_length: int) -> None:
    """Track line ownership, preserving unchanged lines and assigning changed lines to the latest editor."""
    ai_replies = sorted((item for item in chat if item["kind"] == "ai-reply"), key=lambda item: item["t"])
    ai_reply_index = 0
    available_ai_texts: list[str] = []
    previous_lines: list[str] = []
    previous_owners: list[str] = []

    for snapshot in snapshots:
        while ai_reply_index < len(ai_replies) and ai_replies[ai_reply_index]["t"] <= snapshot["t"]:
            reply = ai_replies[ai_reply_index]
            combined = f"{reply.get('message', '')}\n{reply.get('code', '')}"
            normalized = normalized_provenance_text(combined)
            if normalized:
                available_ai_texts.append(normalized)
            ai_reply_index += 1

        current_lines = str(snapshot.get(content_key, "")).replace("\r\n", "\n").split("\n")
        owners = [snapshot["actor"]] * len(current_lines)
        matcher = SequenceMatcher(a=previous_lines, b=current_lines, autojunk=False)
        for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
            if tag == "equal":
                owners[new_start:new_end] = previous_owners[old_start:old_end]
                continue
            if tag != "insert" or not snapshot.get("bulk"):
                continue
            for index in range(new_start, new_end):
                normalized_line = normalized_provenance_text(current_lines[index])
                if len(normalized_line) >= min_ai_length and any(normalized_line in reply for reply in available_ai_texts):
                    owners[index] = "AI"
        snapshot["owners"] = owners
        previous_lines = current_lines
        previous_owners = owners


def add_image_owners(snapshots: list[dict]) -> None:
    """Preserve an image's owner while it remains in the shared note."""
    previous: dict[str, str] = {}
    for snapshot in snapshots:
        current = {
            path: previous.get(path, snapshot["actor"])
            for path in snapshot.get("images", [])
        }
        snapshot["imageOwners"] = [current[path] for path in snapshot.get("images", [])]
        previous = current


def new_group(group_id: str) -> dict:
    return {
        "groupId": group_id,
        "members": {},
        "code": [],
        "notes": [],
        "cursor": [],
        "actions": [],
        "chat": [],
        "status": [],
        "completion": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    groups_dir = output / "groups"
    assets_dir = output / "assets"
    analysis_dir = output / "analysis"
    groups_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)
    analysis_dir.mkdir(parents=True, exist_ok=True)
    csv.field_size_limit(2_147_483_647)

    required = [
        "rooms.csv",
        "codehistories.csv",
        "notehistories.csv",
        "cursorpositions.csv",
        "useractions.csv",
        "chatmessages.csv",
        "taskcompletions.csv",
        "events.csv",
    ]
    missing = [name for name in required if not (source / name).exists()]
    if missing:
        raise FileNotFoundError(f"Missing source files: {', '.join(missing)}")

    groups: dict[str, dict] = defaultdict(lambda: new_group(""))

    def group_for(group_id: str) -> dict:
        if not groups[group_id]["groupId"]:
            groups[group_id]["groupId"] = group_id
        return groups[group_id]

    def register_member(group: dict, actor: str, username: str = "") -> None:
        if not actor or actor == "AI":
            return
        if actor not in group["members"]:
            group["members"][actor] = {"id": actor, "name": actor, "username": username if username != "null" else ""}
        elif username and username != "null" and not group["members"][actor]["username"]:
            group["members"][actor]["username"] = username

    with (source / "rooms.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            group = group_for(row["roomId"])
            for member in parse_json(row.get("members", ""), []):
                register_member(group, str(member.get("anonymName", "")), str(member.get("username", "")))

    with (source / "codehistories.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            group = group_for(row["roomId"])
            actor = row["anonymName"]
            register_member(group, actor, row["username"])
            changes = []
            for change in parse_json(row["changes"], []):
                changes.append({
                    "line": safe_int(change.get("line")),
                    "old": str(change.get("oldContent", "")),
                    "new": str(change.get("newContent", "")),
                })
            group["code"].append({
                "t": parse_time(row["timestamp"]),
                "actor": actor,
                "code": row["code"],
                "bulk": parse_bool(row["isPaste"]),
                "changes": changes,
            })

    asset_cache: dict[str, str] = {}
    with (source / "notehistories.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            group = group_for(row["roomId"])
            actor = row["anonymName"]
            register_member(group, actor, row["username"])
            note_text, images = clean_note(row["note"], assets_dir, asset_cache)
            group["notes"].append({
                "t": parse_time(row["timestamp"]),
                "actor": actor,
                "text": note_text,
                "images": images,
                "bulk": parse_bool(row["isPaste"]),
            })

    with (source / "cursorpositions.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            group = group_for(row["roomId"])
            actor = row["anonymName"]
            register_member(group, actor, row["username"])
            position = parse_json(row["position"], {})
            selection = parse_json(row["selection"], {})
            group["cursor"].append({
                "t": parse_time(row["timestamp"]),
                "actor": actor,
                "line": safe_int(position.get("line")),
                "column": safe_int(position.get("column")),
                "selection": selection,
            })

    with (source / "useractions.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            group = group_for(row["roomId"])
            actor = row["anonymName"]
            register_member(group, actor, row["username"])
            group["actions"].append({
                "t": parse_time(row["timestamp"]),
                "actor": actor,
                "type": row["type"],
                "label": row["buttonLabel"],
            })

    with (source / "chatmessages.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            group = group_for(row["roomId"])
            actor = row["anonymName"]
            register_member(group, actor, row["username"])
            mentions = parse_json(row["mentions"], [])
            message = row["message"]
            if actor == "AI":
                kind = "ai-reply"
            elif "AI" in mentions:
                kind = "ai-question"
            elif message.endswith(" Joined the room") or message.endswith(" Left the room"):
                kind = "system"
            else:
                kind = "chat"
            group["chat"].append({
                "id": row["_id"],
                "t": parse_time(row["timestamp"]),
                "actor": actor,
                "kind": kind,
                "message": message,
                "replyTo": row["replyTo"],
                "hasCode": parse_bool(row["hasCode"]),
                "code": row["codeContent"] if parse_bool(row["hasCode"]) else "",
                "codeType": row["codeType"],
                "hasImage": parse_bool(row["hasImage"]),
                "imageDescription": row["imageDescription"],
            })

    with (source / "taskcompletions.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            group = group_for(row["roomId"])
            completed_by = parse_json(row["completedBy"], {})
            actor = str(completed_by.get("anonymName", ""))
            register_member(group, actor, str(completed_by.get("username", "")))
            group["completion"].append({
                "t": parse_time(row["completedAt"]),
                "actor": actor,
                "finalCodeLength": len(row["finalCode"]),
                "finalNoteLength": len(row["finalNote"]),
            })

    with (source / "events.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["type"] != "user_status":
                continue
            group = group_for(row["group_id"])
            actor = row["anonym_name"]
            register_member(group, actor, row["user_id"])
            content = parse_json(row["content"], {})
            group["status"].append({
                "t": parse_time(row["timestamp"]),
                "actor": actor,
                "status": content.get("status", "unknown"),
                "session": content.get("session_number"),
            })

    posthoc: dict[str, dict] = defaultdict(lambda: {"windows": 0, "icap": Counter()})
    analysis_by_group: dict[str, dict] = defaultdict(
        lambda: {"icapWindows": [], "aiInteractions": [], "noteWindows": [], "codeWindows": []}
    )
    comprehensive = source / "comprehensive_analysis_results.csv"
    if comprehensive.exists():
        with comprehensive.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                group_id = row["group_id"]
                analysis = parse_json(row["icap_analysis"], {})
                if not isinstance(analysis, dict):
                    analysis = {}
                posthoc[group_id]["windows"] += 1
                posthoc[group_id]["icap"][str(analysis.get("icapLevel", "Unknown"))] += 1
                evidence = analysis.get("evidence", {})
                enhanced = analysis.get("enhancedAnalysis", {})
                if not isinstance(evidence, dict):
                    evidence = {}
                if not isinstance(enhanced, dict):
                    enhanced = {}
                anomalies = enhanced.get("collaborationAnomalies", [])
                if not isinstance(anomalies, list):
                    anomalies = []
                analysis_by_group[group_id]["icapWindows"].append({
                    "tStart": parse_time(row["time_window_start"]),
                    "tEnd": parse_time(row["time_window_end"]),
                    "index": safe_int(row["time_window_index"]),
                    "events": safe_int(row["events_count"]),
                    "level": str(analysis.get("icapLevel", "Unknown")),
                    "confidence": analysis.get("confidence"),
                    "summary": str(evidence.get("summary", "")),
                    "activitySummary": str(analysis.get("activitySummary", "")),
                    "patterns": enhanced.get("eventSequencePatterns", []) if isinstance(enhanced.get("eventSequencePatterns", []), list) else [],
                    "interactionScores": enhanced.get("memberInteractionScores", {}) if isinstance(enhanced.get("memberInteractionScores", {}), dict) else {},
                    "anomalies": [
                        {
                            "type": str(item.get("type", "未分类")),
                            "severity": str(item.get("severity", "unknown")),
                            "description": str(item.get("description", "")),
                            "reason": str(item.get("reason", "")),
                            "evidenceCount": len(item.get("evidence", [])) if isinstance(item.get("evidence", []), list) else 0,
                        }
                        for item in anomalies
                        if isinstance(item, dict)
                    ],
                })

    code_analysis = source / "analysis_results.csv"
    if code_analysis.exists():
        with code_analysis.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                evolution = parse_json(row["evolution"], {})
                milestones = parse_json(row["milestones"], [])
                if not isinstance(evolution, dict):
                    evolution = {}
                if not isinstance(milestones, list):
                    milestones = []
                analysis_by_group[row["roomId"]]["codeWindows"].append({
                    "tStart": parse_time(row["time_window_start"]),
                    "tEnd": parse_time(row["time_window_end"]),
                    "events": safe_int(row["total_events"]),
                    "chartTypes": evolution.get("chartTypeProgression", []) if isinstance(evolution.get("chartTypeProgression", []), list) else [],
                    "patterns": evolution.get("userPatterns", []) if isinstance(evolution.get("userPatterns", []), list) else [],
                    "milestones": [
                        {
                            "timestamp": str(item.get("timestamp", "")),
                            "member": str(item.get("memberNumber", "")),
                            "description": str(item.get("description", "")),
                            "type": str(item.get("type", "")),
                            "significance": item.get("significance"),
                        }
                        for item in milestones
                        if isinstance(item, dict)
                    ],
                })

    ai_latest: dict[tuple[str, str], dict] = {}
    ai_analysis = source / "ai_chat_analysis.csv"
    if ai_analysis.exists():
        with ai_analysis.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                key = (row["originalMessageId"], row["aiReplyId"])
                stamp = parse_time(row["analysis_timestamp"] or row["created_at"])
                if key not in ai_latest or stamp >= ai_latest[key][0]:
                    ai_latest[key] = (stamp, row)
    for _stamp, row in ai_latest.values():
        analysis = parse_json(row["analysis_result"], {})
        if not isinstance(analysis, dict):
            continue
        pre = analysis.get("preInteraction", {})
        interaction = analysis.get("interaction", {})
        post = analysis.get("postInteraction", {})
        overall = analysis.get("overallAssessment", {})
        pre = pre if isinstance(pre, dict) else {}
        interaction = interaction if isinstance(interaction, dict) else {}
        post = post if isinstance(post, dict) else {}
        overall = overall if isinstance(overall, dict) else {}
        reactions = post.get("otherMembersReactions", [])
        reactions = reactions if isinstance(reactions, list) else []
        analysis_by_group[row["roomId"]]["aiInteractions"].append({
            "questionT": parse_time(row["userMessageTime"]),
            "replyT": parse_time(row["aiReplyTime"]),
            "user": row["userId"],
            "question": row["userMessage"],
            "questionType": str(interaction.get("questionType", "未分类")),
            "bloom": str(interaction.get("bloomTaxonomy", "未分类")),
            "aiRole": str(interaction.get("aiRole", "未分类")),
            "directAnswer": interaction.get("isDirectAnswerRequest"),
            "triggerFactors": pre.get("triggerFactors", []) if isinstance(pre.get("triggerFactors", []), list) else [],
            "learningNeeds": str(pre.get("learningNeeds", "")),
            "groupImpact": str(post.get("groupImpact", "")),
            "learningOutcome": str(post.get("learningOutcome", "")),
            "knowledgeBuilding": str(post.get("knowledgeBuilding", "")),
            "confidence": post.get("confidence"),
            "otherMemberReactions": len(reactions),
            "benefitedMembers": sum(bool(item.get("benefited")) for item in reactions if isinstance(item, dict)),
            "eventSummary": str(overall.get("eventSummary", "")),
        })

    sampled_note_analysis = source / "sampled_notes_analysis.csv"
    if sampled_note_analysis.exists():
        with sampled_note_analysis.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                result = parse_json(row["analysis_result"], {})
                if not isinstance(result, dict):
                    continue
                summary = result.get("summary", {})
                summary = summary if isinstance(summary, dict) else {}
                insights = result.get("insights", [])
                insights = insights if isinstance(insights, list) else []
                analysis_by_group[row["group_id"]]["noteWindows"].append({
                    "source": "sampled",
                    "tStart": parse_time(row["time_window_start"]),
                    "tEnd": parse_time(row["time_window_end"]),
                    "index": safe_int(row["time_window_index"]),
                    "events": safe_int(row["note_events_count"]),
                    "overallSummary": str(summary.get("overallSummary", "")),
                    "keyFindings": summary.get("keyFindings", []) if isinstance(summary.get("keyFindings", []), list) else [],
                    "collaborationPatterns": summary.get("collaborationPatterns", []) if isinstance(summary.get("collaborationPatterns", []), list) else [],
                    "insights": [
                        {
                            "member": str(item.get("memberNumber", "")),
                            "insight": str(item.get("insight", "")),
                            "category": str(item.get("category", "")),
                            "significance": item.get("significance"),
                            "source": str(item.get("source", "")),
                        }
                        for item in insights
                        if isinstance(item, dict)
                    ],
                })

    full_note_analysis = source / "note_analysis_results.csv"
    if full_note_analysis.exists():
        with full_note_analysis.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                result = parse_json(row["analysis_result"], {})
                if not isinstance(result, dict):
                    continue
                summary = result.get("summary", {})
                summary = summary if isinstance(summary, dict) else {}
                insights = result.get("insights", [])
                insights = insights if isinstance(insights, list) else []
                analysis_by_group[row["roomId"]]["fullNoteAnalysis"] = {
                    "tStart": parse_time(row["time_window_start"]),
                    "tEnd": parse_time(row["time_window_end"]),
                    "events": safe_int(row["note_events_count"]),
                    "overallSummary": str(summary.get("overallSummary", "")),
                    "keyFindings": summary.get("keyFindings", []) if isinstance(summary.get("keyFindings", []), list) else [],
                    "collaborationPatterns": summary.get("collaborationPatterns", []) if isinstance(summary.get("collaborationPatterns", []), list) else [],
                    "totalImages": safe_int(summary.get("totalImages")),
                    "insights": [
                        {
                            "member": str(item.get("memberNumber", "")),
                            "insight": str(item.get("insight", "")),
                            "category": str(item.get("category", "")),
                            "significance": item.get("significance"),
                            "source": str(item.get("source", "")),
                        }
                        for item in insights
                        if isinstance(item, dict)
                    ],
                }

    manifest = []
    manifest_path = source / "_manifest.csv"
    if manifest_path.exists():
        with manifest_path.open("r", encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                manifest.append({
                    "file": row["file"],
                    "rows": safe_int(row["rows"]),
                    "columns": safe_int(row["columns"]),
                })

    totals = Counter()
    group_index = []
    analysis_index = []
    for group_id, group in sorted(groups.items()):
        for field in ("code", "notes", "cursor", "actions", "chat", "status", "completion"):
            group[field].sort(key=lambda item: item["t"])
        event_times = [item["t"] for field in ("code", "notes", "cursor", "actions", "chat", "status", "completion") for item in group[field] if item["t"]]
        substantive = len(group["code"]) + len(group["notes"]) + len(group["cursor"]) + len(group["actions"]) + len(group["chat"])
        if not event_times or not substantive:
            continue
        add_content_owners(group["code"], "code", group["chat"], min_ai_length=12)
        add_content_owners(group["notes"], "text", group["chat"], min_ai_length=18)
        add_image_owners(group["notes"])
        members = sorted(group["members"].values(), key=lambda item: item["id"])
        for index, member in enumerate(members):
            member["color"] = MEMBER_COLORS[index % len(MEMBER_COLORS)]
        group["members"] = members
        counts = {field: len(group[field]) for field in ("code", "notes", "cursor", "actions", "chat", "status", "completion")}
        counts["aiQuestions"] = sum(item["kind"] == "ai-question" for item in group["chat"])
        counts["aiReplies"] = sum(item["kind"] == "ai-reply" for item in group["chat"])
        counts["noteImages"] = sum(len(item["images"]) for item in group["notes"])
        for key, value in counts.items():
            totals[key] += value
        payload = {
            "schemaVersion": 3,
            "groupId": group_id,
            "timelineStart": min(event_times),
            "timelineEnd": max(event_times),
            "members": members,
            "counts": counts,
            "limitations": {
                "terminal": "未采集终端命令、stdout/stderr或报错。",
                "tests": "未采集测试用例及通过/失败结果；打开结果页不代表测试成功。",
                "mouse": "cursorpositions记录的是编辑器文本光标，不是鼠标坐标。",
                "visibility": "online/offline是连接状态，不能等同于离开或切回页面。",
                "chatRead": "未采集消息已读或AI回复查看记录。",
                "ownership": "行级归属由相邻完整快照差分恢复；AI仅标记先前AI回复中足够长且逐字匹配的批量新增行，不表示AI直接操作了编辑器。",
            },
            "posthoc": {
                "windows": posthoc[group_id]["windows"],
                "icap": dict(posthoc[group_id]["icap"]),
                "warning": "这是活动结束后的自动分析摘要，不属于学生实时事件；旧分析中的部分光标事件ID与当前events.csv不兼容。",
            },
            **{field: group[field] for field in ("code", "notes", "cursor", "actions", "chat", "status", "completion")},
        }
        filename = f"{group_id}.json"
        (groups_dir / filename).write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        participation = []
        for person in members:
            actor = person["id"]
            member_counts = {
                "code": sum(item["actor"] == actor for item in group["code"]),
                "notes": sum(item["actor"] == actor for item in group["notes"]),
                "cursor": sum(item["actor"] == actor for item in group["cursor"]),
                "actions": sum(item["actor"] == actor for item in group["actions"]),
                "chat": sum(item["actor"] == actor and item["kind"] not in {"system", "ai-reply"} for item in group["chat"]),
            }
            participation.append({
                "id": actor,
                "color": person["color"],
                "counts": member_counts,
                "total": sum(member_counts.values()),
                "finalCodeLines": Counter(group["code"][-1].get("owners", [])).get(actor, 0) if group["code"] else 0,
                "finalNoteLines": Counter(group["notes"][-1].get("owners", [])).get(actor, 0) if group["notes"] else 0,
            })
        group_analysis = analysis_by_group[group_id]
        for field in ("icapWindows", "aiInteractions", "noteWindows", "codeWindows"):
            group_analysis[field].sort(key=lambda item: item.get("tStart", item.get("questionT", 0)))
        anomaly_counts = Counter(
            anomaly["type"]
            for window in group_analysis["icapWindows"]
            for anomaly in window["anomalies"]
        )
        analysis_payload = {
            "schemaVersion": 1,
            "groupId": group_id,
            "timelineStart": min(event_times),
            "timelineEnd": max(event_times),
            "members": members,
            "counts": counts,
            "participation": participation,
            "artifactAttribution": {
                "finalCode": dict(Counter(group["code"][-1].get("owners", []))) if group["code"] else {},
                "finalNote": dict(Counter(group["notes"][-1].get("owners", []))) if group["notes"] else {},
            },
            "completion": group["completion"],
            "icapWindows": group_analysis["icapWindows"],
            "aiInteractions": group_analysis["aiInteractions"],
            "noteWindows": group_analysis["noteWindows"],
            "fullNoteAnalysis": group_analysis.get("fullNoteAnalysis"),
            "codeWindows": group_analysis["codeWindows"],
            "anomalyCounts": dict(anomaly_counts),
            "limitations": [
                "所有结论均为活动结束后的自动分析，只用于筛查和回看，不应直接作为评价结论。",
                "综合分析中的部分证据时间和旧光标事件ID与当前events.csv不兼容。",
                "行为记录数不等于认知投入，AI文本匹配不等于成员已经阅读或理解AI回复。",
            ],
        }
        analysis_filename = f"{group_id}.json"
        (analysis_dir / analysis_filename).write_text(
            json.dumps(analysis_payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        analysis_index.append({
            "id": group_id,
            "name": group_id,
            "file": f"data/analysis/{analysis_filename}",
            "members": len(members),
            "events": sum(item["total"] for item in participation),
            "ai": len(group_analysis["aiInteractions"]),
            "noteInsights": sum(len(item["insights"]) for item in group_analysis["noteWindows"]),
            "anomalies": sum(anomaly_counts.values()),
            "icap": dict(posthoc[group_id]["icap"]),
            "completed": bool(group["completion"]),
        })
        score = counts["code"] * 3 + counts["notes"] * 2 + counts["chat"] * 4 + counts["actions"]
        group_index.append({
            "id": group_id,
            "name": group_id,
            "file": f"data/groups/{filename}",
            "members": members,
            "counts": counts,
            "start": min(event_times),
            "end": max(event_times),
            "score": score,
        })

    default_group = max(group_index, key=lambda item: item["score"], default={"id": ""})["id"]
    index = {
        "schemaVersion": 3,
        "generatedAt": datetime.now(LOCAL_TZ).isoformat(),
        "source": str(source),
        "defaultGroup": default_group,
        "totals": dict(totals),
        "assetCount": len(asset_cache),
        "manifest": manifest,
        "groups": group_index,
    }
    (output / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    (analysis_dir / "index.json").write_text(
        json.dumps({"schemaVersion": 1, "defaultGroup": default_group, "groups": analysis_index}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        f"Built {len(group_index)} group replays with {sum(len(item['members']) for item in group_index)} members, "
        f"{totals['code']} code snapshots, {totals['notes']} note snapshots, {totals['chat']} chat messages "
        f"and {len(asset_cache)} unique note images."
    )


if __name__ == "__main__":
    main()
