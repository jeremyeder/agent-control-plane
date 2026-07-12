"""Tests for the per-user memory-hub MCP server wiring in build_mcp_servers.

The memory-hub server is attached only when MEMORY_HUB_MCP_URL is set *and* the
current caller's Keycloak JWT is available on the context, and it must carry the
caller's token as an ``Authorization: Bearer`` header so memory is isolated
per-user.

These tests stub ``claude_agent_sdk`` (only present in the ``[claude]`` extra) and
patch the env-dependent helpers so the memory-hub logic can be exercised in
isolation, mirroring the style of test_mcp_config.py.
"""

import sys
import types

import pytest

from ambient_runner.platform.context import RunnerContext


@pytest.fixture
def sdk_stub(monkeypatch: pytest.MonkeyPatch):
    """Install a minimal claude_agent_sdk stub for the function-local import."""
    stub = types.ModuleType("claude_agent_sdk")

    def _create_sdk_mcp_server(**kwargs):
        return {"__sdk_server__": kwargs.get("name")}

    def _tool(*_args, **_kwargs):
        def _decorator(fn):
            return fn

        return _decorator

    stub.create_sdk_mcp_server = _create_sdk_mcp_server
    stub.tool = _tool
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", stub)
    return stub


@pytest.fixture(autouse=True)
def _isolate_helpers(monkeypatch: pytest.MonkeyPatch):
    """Neutralize env-dependent MCP sources so only memory-hub logic varies."""
    monkeypatch.setattr(
        "ambient_runner.platform.config.load_mcp_config",
        lambda *a, **k: {},
    )
    monkeypatch.setattr(
        "ambient_runner.bridges.claude.mcp.build_credential_mcp_servers",
        lambda *a, **k: {},
    )
    # Ensure no ambient sidecar interferes.
    monkeypatch.delenv("AMBIENT_MCP_URL", raising=False)


def _make_context(token: str = "") -> RunnerContext:
    ctx = RunnerContext(
        session_id="test-session",
        workspace_path="/workspace",
        environment={},
    )
    if token:
        ctx.set_current_user("user-1", "User One", token)
    return ctx


def test_memory_hub_added_with_caller_token(
    sdk_stub, monkeypatch: pytest.MonkeyPatch, tmp_path
):
    """memory-hub server is attached with the caller's Bearer token."""
    from ambient_runner.bridges.claude.mcp import build_mcp_servers

    monkeypatch.setenv("MEMORY_HUB_MCP_URL", "https://memory-hub.example.com/mcp")
    ctx = _make_context(token="raw-jwt-token")

    servers = build_mcp_servers(ctx, str(tmp_path))

    assert "memory-hub" in servers
    assert servers["memory-hub"] == {
        "type": "http",
        "url": "https://memory-hub.example.com/mcp",
        "headers": {"Authorization": "Bearer raw-jwt-token"},
    }


def test_memory_hub_preserves_existing_bearer_prefix(
    sdk_stub, monkeypatch: pytest.MonkeyPatch, tmp_path
):
    """A token already prefixed with 'Bearer ' is not double-prefixed."""
    from ambient_runner.bridges.claude.mcp import build_mcp_servers

    monkeypatch.setenv("MEMORY_HUB_MCP_URL", "https://memory-hub.example.com/mcp")
    ctx = _make_context(token="Bearer already-prefixed")

    servers = build_mcp_servers(ctx, str(tmp_path))

    assert servers["memory-hub"]["headers"]["Authorization"] == "Bearer already-prefixed"


def test_memory_hub_absent_without_token(
    sdk_stub, monkeypatch: pytest.MonkeyPatch, tmp_path
):
    """No memory-hub server when the caller token is missing."""
    from ambient_runner.bridges.claude.mcp import build_mcp_servers

    monkeypatch.setenv("MEMORY_HUB_MCP_URL", "https://memory-hub.example.com/mcp")
    ctx = _make_context(token="")

    servers = build_mcp_servers(ctx, str(tmp_path))

    assert "memory-hub" not in servers


def test_memory_hub_absent_without_url(
    sdk_stub, monkeypatch: pytest.MonkeyPatch, tmp_path
):
    """No memory-hub server when MEMORY_HUB_MCP_URL is unset."""
    from ambient_runner.bridges.claude.mcp import build_mcp_servers

    monkeypatch.delenv("MEMORY_HUB_MCP_URL", raising=False)
    ctx = _make_context(token="raw-jwt-token")

    servers = build_mcp_servers(ctx, str(tmp_path))

    assert "memory-hub" not in servers
