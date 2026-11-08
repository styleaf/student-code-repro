#!/usr/bin/env python3
"""Build compact replay data from the exported CSV snapshot."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


LOCAL_TZ = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = ROOT.parent / "prodai_local_20260924"
DEFAULT_OUTPUT = ROOT / "data"


def parse_time(value: str) -> int:
    text = value.strip()
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    parsed = datetime.fromisoformat(text)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=LOCAL_TZ)
    return round(parsed.timestamp() * 1000)


def parse_bool(value: str) -> bool:
    return value.strip().lower() == "true"


def safe_int(value: object, default: int = 0) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def student_filename(group_id: str, anonym_name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", f"{group_id}-{anonym_name}").strip("-")
    digest = hashlib.sha1(f"{group_id}\0{anonym_name}".encode("utf-8")).hexdigest()[:8]
    return f"{slug or 'student'}-{digest}.json"


def new_student(group_id: str, anonym_name: str, username: str) -> dict:
    return {
        "groupId": group_id,
        "studentId": anonym_name,
        "displayName": anonym_name,
        "userIds": {username} if username else set(),
        "code": [],
        "cursor": [],
        "actions": [],
        "status": [],
        "ai": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    source = args.source.resolve()
    output = args.output.resolve()
    students_dir = output / "students"
    students_dir.mkdir(parents=True, exist_ok=True)
    csv.field_size_limit(2_147_483_647)

    required = [
        "codehistories.csv",
        "cursorpositions.csv",
        "useractions.csv",
        "chatmessages.csv",
        "ai_chat_analysis.csv",
        "events.csv",
    ]
    missing = [name for name in required if not (source / name).exists()]
    if missing:
        raise FileNotFoundError(f"Missing source files: {', '.join(missing)}")

    students: dict[tuple[str, str], dict] = {}

    def get_student(group_id: str, anonym_name: str, username: str = "") -> dict:
        key = (group_id, anonym_name)
        if key not in students:
            students[key] = new_student(group_id, anonym_name, username)
        elif username:
            students[key]["userIds"].add(username)
        return students[key]

    with (source / "codehistories.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            student = get_student(row["roomId"], row["anonymName"], row["username"])
            changes = []
            for change in json.loads(row["changes"]):
                changes.append(
                    {
                        "line": safe_int(change.get("line")),
                        "old": str(change.get("oldContent", "")),
                        "new": str(change.get("newContent", "")),
                    }
                )
            student["code"].append(
                {
                    "t": parse_time(row["timestamp"]),
                    "code": row["code"],
                    "paste": parse_bool(row["isPaste"]),
                    "changes": changes,
                }
            )

    with (source / "cursorpositions.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            student = get_student(row["roomId"], row["anonymName"], row["username"])
            position = json.loads(row["position"])
            selection = json.loads(row["selection"])
            student["cursor"].append(
                {
                    "t": parse_time(row["timestamp"]),
                    "line": safe_int(position.get("line")),
                    "column": safe_int(position.get("column")),
                    "selection": selection,
                }
            )

    with (source / "useractions.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            student = get_student(row["roomId"], row["anonymName"], row["username"])
            student["actions"].append(
                {
                    "t": parse_time(row["timestamp"]),
                    "type": row["type"],
                    "label": row["buttonLabel"],
                }
            )

    chat_identity: dict[str, tuple[str, str, str]] = {}
    with (source / "chatmessages.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            chat_identity[row["_id"]] = (row["roomId"], row["anonymName"], row["username"])

    ai_pairs: dict[tuple[str, str], dict] = {}
    with (source / "ai_chat_analysis.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            ai_pairs[(row["originalMessageId"], row["aiReplyId"])] = row

    for (question_id, _reply_id), row in ai_pairs.items():
        identity = chat_identity.get(question_id)
        if not identity:
            continue
        student = get_student(*identity)
        student["ai"].append(
            {
                "questionT": parse_time(row["userMessageTime"]),
                "replyT": parse_time(row["aiReplyTime"]),
                "question": row["userMessage"],
                "reply": row["aiReply"],
            }
        )

    with (source / "events.csv").open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["type"] != "user_status":
                continue
            content = json.loads(row["content"])
            student = get_student(row["group_id"], row["anonym_name"], row["user_id"])
            student["status"].append(
                {
                    "t": parse_time(row["timestamp"]),
                    "status": content.get("status", "unknown"),
                    "session": content.get("session_number"),
                }
            )

    groups: dict[str, list[dict]] = defaultdict(list)
    totals = defaultdict(int)
    default_choice: tuple[int, str, str] | None = None

    for (group_id, anonym_name), student in sorted(students.items()):
        for field in ("code", "cursor", "actions", "status"):
            student[field].sort(key=lambda item: item["t"])
        student["ai"].sort(key=lambda item: item["questionT"])

        all_times = []
        for field in ("code", "cursor", "actions", "status"):
            all_times.extend(item["t"] for item in student[field])
        for item in student["ai"]:
            all_times.extend((item["questionT"], item["replyT"]))
        if not all_times:
            continue

        counts = {
            "code": len(student["code"]),
            "cursor": len(student["cursor"]),
            "actions": len(student["actions"]),
            "status": len(student["status"]),
            "ai": len(student["ai"]),
        }
        for key, value in counts.items():
            totals[key] += value

        filename = student_filename(group_id, anonym_name)
        payload = {
            "schemaVersion": 1,
            "groupId": group_id,
            "studentId": anonym_name,
            "displayName": anonym_name,
            "timelineStart": min(all_times),
            "timelineEnd": max(all_times),
            "counts": counts,
            "limitations": {
                "terminal": False,
                "tests": False,
                "mouse": False,
                "aiDraft": False,
                "aiStream": False,
            },
            "code": student["code"],
            "cursor": student["cursor"],
            "actions": student["actions"],
            "status": student["status"],
            "ai": student["ai"],
        }
        (students_dir / filename).write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )

        score = counts["code"] * 3 + counts["ai"] * 80 + counts["actions"] * 2 + counts["status"]
        if default_choice is None or score > default_choice[0]:
            default_choice = (score, group_id, anonym_name)
        groups[group_id].append(
            {
                "id": anonym_name,
                "name": anonym_name,
                "file": f"data/students/{filename}",
                "counts": counts,
                "start": min(all_times),
                "end": max(all_times),
                "score": score,
            }
        )

    index = {
        "schemaVersion": 1,
        "generatedAt": datetime.now(LOCAL_TZ).isoformat(),
        "source": str(source),
        "default": {
            "groupId": default_choice[1] if default_choice else "",
            "studentId": default_choice[2] if default_choice else "",
        },
        "totals": dict(totals),
        "groups": [
            {
                "id": group_id,
                "name": group_id,
                "students": sorted(items, key=lambda item: (-item["score"], item["name"])),
            }
            for group_id, items in sorted(groups.items())
        ],
    }
    (output / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(
        f"Built replay data for {sum(len(group['students']) for group in index['groups'])} students "
        f"in {len(index['groups'])} groups."
    )


if __name__ == "__main__":
    main()
