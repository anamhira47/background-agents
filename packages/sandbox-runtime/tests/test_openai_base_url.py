import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tests.runtime_helpers import make_opencode_server


async def _spawned_config(tmp_path) -> dict:
    server = make_opencode_server({}, workspace_path=tmp_path)
    with (
        patch.object(server, "_setup_managed_oauth"),
        patch.object(server, "_prepare_opencode_filesystem", return_value=set()),
        patch.object(server, "_wait_for_health", new_callable=AsyncMock),
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_subprocess_exec",
            new_callable=AsyncMock,
            return_value=MagicMock(stdout=None),
        ) as spawn,
        patch(
            "sandbox_runtime.opencode_server.asyncio.create_task",
            side_effect=lambda coro: coro.close(),
        ),
    ):
        await server.start((), tmp_path)
    return json.loads(spawn.call_args.kwargs["env"]["OPENCODE_CONFIG_CONTENT"])


async def test_openai_base_url_routes_openai_provider(tmp_path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENAI_BASE_URL", "https://llm.example.test/v1")

    config = await _spawned_config(tmp_path)

    assert config["provider"]["openai"] == {"options": {"baseURL": "https://llm.example.test/v1"}}
    assert "anthropic" in config["provider"]


async def test_openai_provider_keeps_default_endpoint_without_base_url(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)

    config = await _spawned_config(tmp_path)

    assert "openai" not in config["provider"]
