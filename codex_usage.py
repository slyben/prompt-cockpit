#!/usr/bin/env python3
"""Offline Codex usage and cost report.

This reads Codex rollout JSONL files directly. It does not start Codex, call
the app-server, contact the network, or import anything from Prompt Cockpit.

Examples:
    python codex_usage.py
    python codex_usage.py --range 7d
    python codex_usage.py --sessions-dir C:\\Users\\me\\.codex\\sessions
    python codex_usage.py --json

The default rates are a copy of the pricing table shipped with Prompt
Cockpit. When this file is run from the repository, the adjacent
src/pricing_codex.json is preferred; --pricing can point at any updated copy
of that JSON file.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


# Offline fallback. Keep this self-contained so the script still works when
# copied out of the repository. A local --pricing file overrides these rates.
DEFAULT_RATES: dict[str, dict[str, float]] = {
    "gpt-6-astra": {"input": 10, "output": 50, "cache_write_5m": 12.5, "cache_write_1h": 12.5, "cache_read": 1},
    "gpt-6-sol": {"input": 2, "output": 10, "cache_write_5m": 2.5, "cache_write_1h": 2.5, "cache_read": 0.2},
    "gpt-6-luna": {"input": 0.1, "output": 0.5, "cache_write_5m": 0.125, "cache_write_1h": 0.125, "cache_read": 0.01},
    "gpt-5.6-sol": {"input": 4, "output": 20, "cache_write_5m": 5, "cache_write_1h": 5, "cache_read": 0.4},
    "gpt-5.6": {"input": 4, "output": 20, "cache_write_5m": 5, "cache_write_1h": 5, "cache_read": 0.4},
    "gpt-5.6-terra": {"input": 2, "output": 12, "cache_write_5m": 2.5, "cache_write_1h": 2.5, "cache_read": 0.2},
    "gpt-5.6-luna": {"input": 0.2, "output": 1.2, "cache_write_5m": 0.25, "cache_write_1h": 0.25, "cache_read": 0.02},
    "gpt-5.5": {"input": 5, "output": 30, "cache_write_5m": 5, "cache_write_1h": 5, "cache_read": 0.5},
    "gpt-5-codex": {"input": 1.25, "output": 10, "cache_write_5m": 1.25, "cache_write_1h": 1.25, "cache_read": 0.125},
    "gpt-5.1-codex": {"input": 1.25, "output": 10, "cache_write_5m": 1.25, "cache_write_1h": 1.25, "cache_read": 0.125},
    "gpt-5.1-codex-mini": {"input": 0.25, "output": 2, "cache_write_5m": 0.25, "cache_write_1h": 0.25, "cache_read": 0.025},
    "gpt-5.1-codex-max": {"input": 1.25, "output": 10, "cache_write_5m": 1.25, "cache_write_1h": 1.25, "cache_read": 0.125},
    "gpt-5.2-codex": {"input": 1.75, "output": 14, "cache_write_5m": 1.75, "cache_write_1h": 1.75, "cache_read": 0.175},
    "codex-mini-latest": {"input": 1.5, "output": 6, "cache_write_5m": 1.5, "cache_write_1h": 1.5, "cache_read": 0.375},
    "gpt-5.3-codex": {"input": 1.75, "output": 14, "cache_write_5m": 1.75, "cache_write_1h": 1.75, "cache_read": 0.175},
    "gpt-5.4": {"input": 2.5, "output": 15, "cache_write_5m": 2.5, "cache_write_1h": 2.5, "cache_read": 0.25},
    "gpt-5.4-mini": {"input": 0.75, "output": 4.5, "cache_write_5m": 0.75, "cache_write_1h": 0.75, "cache_read": 0.075},
}

UUID_AT_END = re.compile(r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$", re.I)


def number_or_zero(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number >= 0 else 0.0


def timestamp_ms(value: Any) -> float | None:
    """Convert Codex seconds/milliseconds/ISO timestamps to epoch ms."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value * 1000 if value < 10_000_000_000 else float(value)
    if isinstance(value, str):
        try:
            numeric = float(value)
            return numeric * 1000 if numeric < 10_000_000_000 else numeric
        except ValueError:
            pass
        try:
            text = value.replace("Z", "+00:00")
            parsed = datetime.fromisoformat(text)
            if parsed.tzinfo is None:
                parsed = parsed.astimezone()
            return parsed.timestamp() * 1000
        except ValueError:
            return None
    return None


def model_from_entry(entry: dict[str, Any]) -> str | None:
    payload = entry.get("payload") or {}
    if not isinstance(payload, dict):
        return None
    if payload.get("model"):
        return str(payload["model"])
    base = payload.get("base_instructions") or {}
    if not isinstance(base, dict):
        return None
    provenance = base.get("provenance") or {}
    if isinstance(provenance, dict) and provenance.get("model"):
        return str(provenance["model"])
    if base.get("model"):
        return str(base["model"])
    return None


def usage_to_shared(raw: Any) -> dict[str, float] | None:
    """Match the normalization used by the cockpit's Codex history scanner."""
    if not isinstance(raw, dict):
        return None
    raw_input = raw.get("input_tokens", raw.get("inputTokens"))
    raw_output = raw.get("output_tokens", raw.get("outputTokens"))
    if raw_input is None and raw_output is None:
        return None

    details = raw.get("input_tokens_details") or {}
    camel_details = raw.get("inputTokensDetails") or {}
    if not isinstance(details, dict):
        details = {}
    if not isinstance(camel_details, dict):
        camel_details = {}

    cached = number_or_zero(
        raw.get(
            "cached_input_tokens",
            raw.get(
                "cachedInputTokens",
                raw.get(
                    "cache_read_input_tokens",
                    details.get("cached_tokens", camel_details.get("cachedTokens")),
                ),
            ),
        )
    )
    written = number_or_zero(
        raw.get(
            "cache_write_input_tokens",
            raw.get(
                "cacheWriteInputTokens",
                raw.get("cache_creation_input_tokens", raw.get("cacheCreationInputTokens")),
            ),
        )
    )
    has_cached_app_server_shape = any(
        value is not None
        for value in (
            raw.get("cached_input_tokens"),
            raw.get("cachedInputTokens"),
            raw.get("cache_write_input_tokens"),
            raw.get("cacheWriteInputTokens"),
            details.get("cached_tokens"),
            camel_details.get("cachedTokens"),
        )
    )
    input_tokens = number_or_zero(raw_input)
    if has_cached_app_server_shape:
        input_tokens = max(0.0, input_tokens - cached - written)

    return {
        "input_tokens": input_tokens,
        "output_tokens": number_or_zero(raw_output),
        "cache_read_input_tokens": cached,
        "cache_creation_input_tokens": written,
    }


def usage_record(entry: dict[str, Any]) -> tuple[str, str | None, str | None, dict[str, float] | None] | None:
    payload = entry.get("payload") or {}
    if not isinstance(payload, dict):
        return None

    if entry.get("type") == "token_usage_record":
        usage = payload.get("usage") or payload.get("last_token_usage") or payload.get("lastTokenUsage")
        return (
            "record",
            payload.get("turn_id") or payload.get("turnId"),
            payload.get("model"),
            usage_to_shared(usage),
        )

    if entry.get("type") == "event_msg" and payload.get("type") == "token_count":
        info = payload.get("info") or {}
        if not isinstance(info, dict):
            info = {}
        usage = info.get("last_token_usage") or info.get("lastTokenUsage")
        return (
            "legacy",
            payload.get("turn_id") or payload.get("turnId"),
            payload.get("model"),
            usage_to_shared(usage),
        )
    return None


def session_id_from_file(path: Path) -> str | None:
    match = UUID_AT_END.match(path.stem)
    return match.group(1) if match else None


def scan_file(path: Path) -> dict[str, Any]:
    state: dict[str, Any] = {
        "path": str(path),
        "session_id": session_id_from_file(path),
        "first_ts": None,
        "last_ts": None,
        "usage_rows": [],
        "legacy_rows": [],
        "turn_models": {},
        "fallback_model": None,
        "bad_lines": 0,
    }

    try:
        handle = path.open("r", encoding="utf-8")
    except OSError as exc:
        state["error"] = str(exc)
        return state

    with handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                state["bad_lines"] += 1
                continue
            if not isinstance(entry, dict):
                continue

            ts = timestamp_ms(entry.get("timestamp"))
            if ts is not None:
                state["first_ts"] = ts if state["first_ts"] is None else min(state["first_ts"], ts)
                state["last_ts"] = ts if state["last_ts"] is None else max(state["last_ts"], ts)

            entry_type = entry.get("type")
            payload = entry.get("payload") or {}
            if not isinstance(payload, dict):
                payload = {}
            if entry_type == "session_meta":
                nested_ts = timestamp_ms(payload.get("timestamp"))
                if nested_ts is not None:
                    state["first_ts"] = nested_ts if state["first_ts"] is None else min(state["first_ts"], nested_ts)
                    state["last_ts"] = nested_ts if state["last_ts"] is None else max(state["last_ts"], nested_ts)
                state["session_id"] = payload.get("session_id") or payload.get("id") or state["session_id"]
                state["fallback_model"] = model_from_entry(entry) or state["fallback_model"]
            elif entry_type == "turn_context":
                turn_id = payload.get("turn_id") or payload.get("turnId")
                model = model_from_entry(entry)
                if turn_id and model:
                    state["turn_models"][turn_id] = model
                state["fallback_model"] = model or state["fallback_model"]

            record = usage_record(entry)
            if not record or record[3] is None:
                continue
            kind, turn_id, model, usage = record
            # Legacy records without a turn id need the model that was active
            # at the point where the record appeared, not the file's final
            # model.
            row_model = model or (None if turn_id else state["fallback_model"])
            row = {"ts": ts, "turn_id": turn_id, "model": row_model, "usage": usage}
            state["usage_rows" if kind == "record" else "legacy_rows"].append(row)

    selected_rows = state["usage_rows"] or state["legacy_rows"]
    rows = []
    for row in selected_rows:
        resolved = row["model"] or state["turn_models"].get(row["turn_id"]) or state["fallback_model"]
        rows.append({**row, "model": resolved})
    if not rows and state["last_ts"] is not None:
        # Preserve activity for rollout files that have no readable token
        # record, without inventing any token or cost totals.
        rows.append({"ts": state["last_ts"], "turn_id": None, "model": state["fallback_model"], "usage": None})
    state["rows"] = rows
    return state


def iter_jsonl_files(root: Path) -> Iterable[Path]:
    for directory, _subdirectories, filenames in os.walk(root):
        for filename in filenames:
            if filename.lower().endswith(".jsonl"):
                yield Path(directory) / filename


def merge_scans(scans: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for scan in scans:
        # Files without a session id are kept separate, just as separate
        # rollout files should be; identified sessions are merged if Codex
        # has split one across multiple files.
        key = scan.get("session_id") or f"file:{scan['path']}"
        existing = merged.get(key)
        if existing is None:
            merged[key] = scan
            continue
        existing["rows"].extend(scan.get("rows", []))
        for field in ("first_ts", "last_ts"):
            value = scan.get(field)
            if value is not None:
                if existing[field] is None:
                    existing[field] = value
                elif field == "first_ts":
                    existing[field] = min(existing[field], value)
                else:
                    existing[field] = max(existing[field], value)
        existing["bad_lines"] += scan.get("bad_lines", 0)
    return list(merged.values())


def load_rates(path_arg: str | None) -> tuple[dict[str, dict[str, float]], str]:
    if path_arg:
        path = Path(path_arg).expanduser()
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data.get("models", data), str(path)

    repository_pricing = Path(__file__).resolve().parent / "src" / "pricing_codex.json"
    if repository_pricing.is_file():
        with repository_pricing.open("r", encoding="utf-8") as handle:
            return json.load(handle)["models"], str(repository_pricing)
    return DEFAULT_RATES, "embedded fallback rates"


def local_sessions_dir() -> Path:
    codex_home = os.environ.get("CODEX_HOME")
    return Path(codex_home).expanduser() / "sessions" if codex_home else Path.home() / ".codex" / "sessions"


def date_label(ts: float | None) -> str:
    if ts is None:
        return "-"
    return datetime.fromtimestamp(ts / 1000).astimezone().strftime("%Y-%m-%d %H:%M")


def format_count(value: float) -> str:
    if value == int(value):
        return f"{int(value):,}"
    return f"{value:,.2f}"


def format_usd(value: float) -> str:
    return f"${value:,.6f}"


def cutoff_for_range(range_name: str) -> float | None:
    if range_name == "all":
        return None
    return (time.time() - int(range_name[:-1]) * 86400) * 1000


def compute_report(scans: list[dict[str, Any]], rates: dict[str, dict[str, float]], cutoff: float | None) -> dict[str, Any]:
    totals = {
        "input_tokens": 0.0,
        "output_tokens": 0.0,
        "cache_read_tokens": 0.0,
        "cache_write_tokens": 0.0,
        "cost_usd": 0.0,
    }
    models: dict[str, dict[str, Any]] = {}
    by_day: dict[str, dict[str, float]] = defaultdict(lambda: {"messages": 0, "cost_usd": 0.0})
    sessions = 0
    sessions_with_usage = 0
    usage_records = 0
    activity_only_sessions = 0
    first_ts = None
    last_ts = None
    unpriced: set[str] = set()

    for scan in scans:
        rows = [row for row in scan.get("rows", []) if row.get("ts") is not None and (cutoff is None or row["ts"] >= cutoff)]
        if not rows:
            continue
        sessions += 1
        usage_rows = [row for row in rows if row.get("usage")]
        if usage_rows:
            sessions_with_usage += 1
        else:
            activity_only_sessions += 1
        timestamps = [row["ts"] for row in rows]
        first_ts = min(timestamps) if first_ts is None else min(first_ts, min(timestamps))
        last_ts = max(timestamps) if last_ts is None else max(last_ts, max(timestamps))

        for row in usage_rows:
            usage = row["usage"]
            model = row.get("model") or "(unknown model)"
            input_tokens = number_or_zero(usage.get("input_tokens"))
            output_tokens = number_or_zero(usage.get("output_tokens"))
            cache_read = number_or_zero(usage.get("cache_read_input_tokens"))
            cache_write = number_or_zero(usage.get("cache_creation_input_tokens"))
            totals["input_tokens"] += input_tokens
            totals["output_tokens"] += output_tokens
            totals["cache_read_tokens"] += cache_read
            totals["cache_write_tokens"] += cache_write
            usage_records += 1

            model_row = models.setdefault(model, {
                "calls": 0,
                "input_tokens": 0.0,
                "output_tokens": 0.0,
                "cache_read_tokens": 0.0,
                "cache_write_tokens": 0.0,
                "cost_usd": None,
            })
            model_row["calls"] += 1
            model_row["input_tokens"] += input_tokens
            model_row["output_tokens"] += output_tokens
            model_row["cache_read_tokens"] += cache_read
            model_row["cache_write_tokens"] += cache_write

            rate = rates.get(model)
            cost = None
            if rate is not None:
                cost = (
                    input_tokens * float(rate.get("input", 0))
                    + output_tokens * float(rate.get("output", 0))
                    + cache_write * float(rate.get("cache_write_5m", 0))
                    + cache_read * float(rate.get("cache_read", 0))
                ) / 1_000_000
                model_row["cost_usd"] = (model_row["cost_usd"] or 0.0) + cost
                totals["cost_usd"] += cost
            else:
                unpriced.add(model)

            if row["ts"] is not None:
                day = datetime.fromtimestamp(row["ts"] / 1000).astimezone().strftime("%Y-%m-%d")
                by_day[day]["messages"] += 1
                if cost is not None:
                    by_day[day]["cost_usd"] += cost

    totals["total_tokens"] = sum(totals[key] for key in (
        "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"
    ))
    return {
        "sessions": sessions,
        "sessions_with_usage": sessions_with_usage,
        "activity_only_sessions": activity_only_sessions,
        "usage_records": usage_records,
        "first_activity": date_label(first_ts),
        "last_activity": date_label(last_ts),
        **totals,
        "models": [
            {"model": model, **row}
            for model, row in sorted(
                models.items(),
                key=lambda item: (item[1]["cost_usd"] is not None, item[1]["cost_usd"] or 0),
                reverse=True,
            )
        ],
        "by_day": {day: values for day, values in sorted(by_day.items())},
        "unpriced_models": sorted(unpriced),
    }


def print_report(report: dict[str, Any], sessions_dir: Path, pricing_source: str, range_name: str) -> None:
    print("Codex offline usage")
    print(f"Source: {sessions_dir}")
    print(f"Range: {range_name}")
    print(f"Pricing: {pricing_source}")
    print()
    print(f"Sessions: {report['sessions']} ({report['sessions_with_usage']} with token records)")
    if report["activity_only_sessions"]:
        print(f"Activity-only sessions: {report['activity_only_sessions']} (no token records to price)")
    print(f"Usage records: {report['usage_records']}")
    print(f"Activity: {report['first_activity']} -> {report['last_activity']}")
    print(f"Input tokens (uncached): {format_count(report['input_tokens'])}")
    print(f"Output tokens: {format_count(report['output_tokens'])}")
    print(f"Cache read tokens: {format_count(report['cache_read_tokens'])}")
    print(f"Cache write tokens: {format_count(report['cache_write_tokens'])}")
    print(f"Total tokens: {format_count(report['total_tokens'])}")
    print(f"Estimated cost: {format_usd(report['cost_usd'])}")

    if report["models"]:
        print()
        print("By model:")
        print(f"{'Model':<28} {'Calls':>7} {'Input':>14} {'Output':>14} {'Cost':>14}")
        print("-" * 82)
        for row in report["models"]:
            cost = "unpriced" if row["cost_usd"] is None else format_usd(row["cost_usd"])
            print(
                f"{row['model']:<28.28} {row['calls']:>7} {format_count(row['input_tokens']):>14} "
                f"{format_count(row['output_tokens']):>14} {cost:>14}"
            )

    if report["unpriced_models"]:
        print()
        print("Unpriced models: " + ", ".join(report["unpriced_models"]))
        print("Their tokens are included, but their cost is excluded until a rate is supplied.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Report Codex usage and estimated cost from local rollout files.")
    parser.add_argument(
        "--sessions-dir",
        type=Path,
        default=local_sessions_dir(),
        help="Codex sessions directory (default: CODEX_HOME/sessions or ~/.codex/sessions)",
    )
    parser.add_argument(
        "--range",
        choices=("all", "7d", "30d"),
        default="all",
        help="Time window, based on the current local time (default: all)",
    )
    parser.add_argument(
        "--pricing",
        help="Optional pricing_codex.json; otherwise use the repository copy or embedded rates",
    )
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON instead of the report")
    parser.add_argument("--by-day", action="store_true", help="Append a daily cost table to the human-readable report")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    sessions_dir = args.sessions_dir.expanduser()
    if not sessions_dir.is_dir():
        print(f"Codex sessions directory not found: {sessions_dir}", file=sys.stderr)
        return 2

    try:
        rates, pricing_source = load_rates(args.pricing)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"Could not load pricing: {exc}", file=sys.stderr)
        return 2

    paths = list(iter_jsonl_files(sessions_dir))
    scans = merge_scans(scan_file(path) for path in paths)
    report = compute_report(scans, rates, cutoff_for_range(args.range))
    report.update({
        "sessions_dir": str(sessions_dir),
        "pricing_source": pricing_source,
        "range": args.range,
        "jsonl_files": len(paths),
    })

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print_report(report, sessions_dir, pricing_source, args.range)
        if args.by_day and report["by_day"]:
            print()
            print("By day:")
            for day, values in report["by_day"].items():
                print(f"{day}: {values['messages']} messages, {format_usd(values['cost_usd'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
