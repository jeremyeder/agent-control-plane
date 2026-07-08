from pathlib import Path
from unittest.mock import patch

from ambient_runner.bridges.claude import ClaudeBridge
from ambient_runner.platform.context import RunnerContext
from ambient_runner.platform.workspace import resolve_workspace_paths


def test_resolve_workspace_paths_adds_session_config_harness(
    tmp_path: Path,
    monkeypatch,
) -> None:
    workspace = tmp_path / "workspace"
    repo = workspace / "repos" / "app"
    session_config = tmp_path / "sandbox" / "session-config"
    repo.mkdir(parents=True)
    session_config.mkdir(parents=True)

    monkeypatch.setenv(
        "REPOS_JSON",
        '[{"name":"app","url":"https://github.com/example/app.git"}]',
    )
    monkeypatch.setenv("SESSION_CONFIG_PATH", str(session_config))
    monkeypatch.delenv("ACTIVE_WORKFLOW_GIT_URL", raising=False)

    context = RunnerContext(session_id="s1", workspace_path=str(workspace))

    cwd_path, add_dirs = resolve_workspace_paths(context)

    assert cwd_path == str(repo)
    assert str(session_config) in add_dirs


def test_claude_adapter_enables_skills_for_session_config_harness(
    tmp_path: Path,
    monkeypatch,
) -> None:
    session_config = tmp_path / "sandbox" / "session-config"
    session_config.mkdir(parents=True)
    monkeypatch.setenv("SESSION_CONFIG_PATH", str(session_config))

    bridge = ClaudeBridge()
    bridge._cwd_path = "/workspace/repos/app"
    bridge._allowed_tools = ["Read", "Write", "Bash"]
    bridge._mcp_servers = {}
    bridge._system_prompt = {
        "type": "preset",
        "preset": "claude_code",
        "append": "base",
    }

    with patch(
        "ambient_runner.bridges.claude.bridge.ClaudeAgentAdapter",
    ) as adapter_class:
        bridge._ensure_adapter()

    options = adapter_class.call_args[1]["options"]
    assert options["skills"] == "all"
