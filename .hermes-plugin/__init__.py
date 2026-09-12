"""Stop That Shit Hermes Agent native plugin.

The plugin is a thin, fail-open Python host adapter.  Policy remains in the
self-contained generated Node runtime next to this file; this module only
translates Hermes hook keyword arguments to the existing envelope protocol.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

_PLUGIN_ROOT = Path(__file__).resolve().parent
_RUNTIME = _PLUGIN_ROOT / "runtime" / "stop-that-shit.cjs"
_TIMEOUT_SECONDS = 2.0


def _hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")


def _invoke(envelope: dict[str, Any]) -> dict[str, Any] | None:
    """Run the bundled runtime and return its structured response, fail-open."""
    try:
        completed = subprocess.run(
            ["node", str(_RUNTIME)],
            input=json.dumps(envelope) + "\n",
            text=True,
            capture_output=True,
            timeout=_TIMEOUT_SECONDS,
            cwd=str(_PLUGIN_ROOT),
            env={**os.environ, "HERMES_HOME": _hermes_home()},
            check=False,
        )
        if completed.returncode != 0 or not completed.stdout.strip():
            return None
        result = json.loads(completed.stdout)
        return result if isinstance(result, dict) else None
    except (OSError, subprocess.SubprocessError, ValueError, TypeError):
        return None


def _prompt(**kwargs: Any) -> dict[str, Any] | None:
    result = _invoke({
        "hook_event_name": "pre_llm_call",
        "session_id": kwargs.get("session_id", ""),
        "model": kwargs.get("model"),
        "extra": {
            "user_message": kwargs.get("user_message", ""),
            "turn_id": kwargs.get("turn_id"),
            "model": kwargs.get("model"),
        },
    })
    return result if result and result.get("context") else None


def _tool(**kwargs: Any) -> dict[str, Any] | None:
    result = _invoke({
        "hook_event_name": "pre_tool_call",
        "session_id": kwargs.get("session_id", ""),
        "tool_call_id": kwargs.get("tool_call_id"),
        "tool_name": kwargs.get("tool_name"),
        "tool_input": kwargs.get("args") or {},
        "cwd": kwargs.get("cwd"),
        "extra": {
            "tool_call_id": kwargs.get("tool_call_id"),
            "turn_id": kwargs.get("turn_id"),
            "user_message": kwargs.get("user_message", ""),
            "async_launched": kwargs.get("async_launched", kwargs.get("asyncLaunched")),
            "run_in_background": kwargs.get("run_in_background", kwargs.get("runInBackground")),
        },
    })
    return result if result and result.get("action") == "block" else None


def _post_tool(**kwargs: Any) -> None:
    _invoke({
        "hook_event_name": "post_tool_call",
        "session_id": kwargs.get("session_id", ""),
        "tool_call_id": kwargs.get("tool_call_id"),
        "tool_name": kwargs.get("tool_name"),
        "tool_input": kwargs.get("args") or {},
        "cwd": kwargs.get("cwd"),
        "extra": {
            "tool_call_id": kwargs.get("tool_call_id"),
            "turn_id": kwargs.get("turn_id"),
            "task_id": kwargs.get("task_id"),
            "result": kwargs.get("result"),
            "duration_ms": kwargs.get("duration_ms"),
            "status": kwargs.get("status"),
            "error_type": kwargs.get("error_type"),
            "error_message": kwargs.get("error_message"),
            "async_launched": kwargs.get("async_launched", kwargs.get("asyncLaunched")),
            "run_in_background": kwargs.get("run_in_background", kwargs.get("runInBackground")),
        },
    })


def _subagent_start(**kwargs: Any) -> None:
    _invoke({
        "hook_event_name": "subagent_start",
        "session_id": kwargs.get("parent_session_id") or kwargs.get("session_id", ""),
        "extra": {
            "parent_session_id": kwargs.get("parent_session_id"),
            "parent_turn_id": kwargs.get("parent_turn_id"),
            "parent_subagent_id": kwargs.get("parent_subagent_id"),
            "child_session_id": kwargs.get("child_session_id"),
            "child_subagent_id": kwargs.get("child_subagent_id"),
            "child_role": kwargs.get("child_role"),
            "child_goal": kwargs.get("child_goal"),
            "reservation_id": kwargs.get("reservation_id"),
        },
    })


def _subagent_stop(**kwargs: Any) -> None:
    _invoke({
        "hook_event_name": "subagent_stop",
        "session_id": kwargs.get("parent_session_id") or kwargs.get("session_id", ""),
        "extra": {
            "parent_session_id": kwargs.get("parent_session_id"),
            "parent_turn_id": kwargs.get("parent_turn_id"),
            "child_session_id": kwargs.get("child_session_id"),
            "child_subagent_id": kwargs.get("child_subagent_id"),
            "child_role": kwargs.get("child_role"),
            "child_summary": kwargs.get("child_summary"),
            "child_status": kwargs.get("child_status"),
            "duration_ms": kwargs.get("duration_ms"),
        },
    })


def _session_end(**kwargs: Any) -> None:
    _invoke({
        "hook_event_name": "on_session_end",
        "session_id": kwargs.get("session_id", ""),
        "extra": {
            "completed": kwargs.get("completed"),
            "interrupted": kwargs.get("interrupted"),
            "model": kwargs.get("model"),
            "platform": kwargs.get("platform"),
        },
    })


def register(ctx) -> None:
    """Register the Hermes policy and lifecycle hooks."""
    ctx.register_hook("pre_llm_call", _prompt)
    ctx.register_hook("pre_tool_call", _tool)
    ctx.register_hook("post_tool_call", _post_tool)
    ctx.register_hook("subagent_start", _subagent_start)
    ctx.register_hook("subagent_stop", _subagent_stop)
    ctx.register_hook("on_session_end", _session_end)
