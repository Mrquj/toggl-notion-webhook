from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

from atimelogger_automation import load_settings, save_settings


PROJECT_DIR = Path(__file__).resolve().parent
LOG_DIR = PROJECT_DIR / "logs"
LOG_FILE = LOG_DIR / "atimelogger-auto-sync.log"
MAX_LOG_SIZE = 2 * 1024 * 1024


def find_npm() -> str | None:
    command = "npm.cmd" if os.name == "nt" else "npm"
    found = shutil.which(command)
    if found:
        return found

    if os.name == "nt":
        standard_path = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "npm.cmd"
        if standard_path.exists():
            return str(standard_path)

    if sys.platform.startswith("linux"):
        for candidate in (Path("/usr/bin/npm"), Path("/usr/local/bin/npm")):
            if candidate.exists():
                return str(candidate)

        shell = os.environ.get("SHELL")
        if shell:
            lookup = subprocess.run(
                [shell, "-lc", "command -v npm"],
                capture_output=True,
                text=True,
                errors="replace",
            )
            found = lookup.stdout.strip()
            if lookup.returncode == 0 and found:
                return found

    return None


def extract_summary(output: str) -> dict | None:
    decoder = json.JSONDecoder()
    last_summary = None

    for index, char in enumerate(output):
        if char != "{":
            continue

        try:
            value, _ = decoder.raw_decode(output[index:])
        except json.JSONDecodeError:
            continue

        if isinstance(value, dict) and "calendarEvents" in value and "dryRun" in value:
            last_summary = value

    return last_summary


def write_log(message: str) -> None:
    LOG_DIR.mkdir(exist_ok=True)
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > MAX_LOG_SIZE:
        backup = LOG_FILE.with_suffix(".previous.log")
        backup.unlink(missing_ok=True)
        LOG_FILE.replace(backup)

    with LOG_FILE.open("a", encoding="utf-8") as log:
        log.write(message.rstrip() + "\n")


def scheduled_run_is_due() -> tuple[bool, dict]:
    settings = load_settings()
    frequency = settings.get("frequency", "每天")
    interval_days = {
        "每天": 1,
        "每隔 2 天": 2,
        "每隔 7 天": 7,
        "每周固定一天": 1,
    }.get(frequency, 1)

    last_run_text = settings.get("last_scheduled_run")
    if interval_days <= 1 or not last_run_text:
        return True, settings

    try:
        last_run = date.fromisoformat(last_run_text)
    except ValueError:
        return True, settings

    return (date.today() - last_run).days >= interval_days, settings


def main() -> int:
    timestamp = datetime.now().astimezone().isoformat(timespec="seconds")
    is_scheduled = "--scheduled" in sys.argv
    settings = None
    if is_scheduled:
        is_due, settings = scheduled_run_is_due()
        if not is_due:
            write_log(f"[{timestamp}] SKIPPED: scheduled frequency is not due today")
            return 0

    npm = find_npm()
    if not npm:
        write_log(f"[{timestamp}] FAILED: npm not found")
        return 1

    startupinfo = None
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

    _cal_days = max(1, int(os.environ.get("SYNC_CALENDAR_DAYS", "3") or "3"))
    _cal_start = (date.today() - timedelta(days=_cal_days - 1)).isoformat()
    completed = subprocess.run(
        [npm, "run", "sync:atimelogger-calendar", "--", "--date", _cal_start, "--days", str(_cal_days)],
        cwd=PROJECT_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "NO_COLOR": "1"},
        startupinfo=startupinfo,
    )

    output = "\n".join(part for part in [completed.stdout, completed.stderr] if part)
    summary = extract_summary(output)
    if summary:
        result = {
            "date": summary.get("date"),
            "calendars": summary.get("calendars", []),
            "calendarEvents": summary.get("calendarEvents", 0),
            "created": summary.get("created", 0),
            "skipped": summary.get("skipped", 0),
            "failed": summary.get("failed", 0),
            "dryRun": summary.get("dryRun", False),
        }
        write_log(f"[{timestamp}] exit={completed.returncode} {json.dumps(result, ensure_ascii=False)}")
    else:
        compact_output = output.strip().replace("\n", " ")[:1200]
        write_log(f"[{timestamp}] exit={completed.returncode} {compact_output}")

    if is_scheduled and settings is not None:
        settings["last_scheduled_run"] = date.today().isoformat()
        save_settings(settings)

    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
