from __future__ import annotations

import asyncio
import json
import os
from datetime import timedelta
from importlib.metadata import version
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


EXPECTED_TOOLS = {
    "execute_blender_code",
    "get_addon_status",
    "get_scene_info",
}
EXPECTED_PACKAGE_VERSION = "1.8.7"
EXPECTED_SERVER_NAME = "BlenderMCP"
REQUEST_TIMEOUT = timedelta(seconds=10)
SMOKE_TIMEOUT_SECONDS = 20


def resolve_server_command(upstream_root: Path) -> Path:
    if os.name == "nt":
        command = upstream_root / ".venv" / "Scripts" / "blender-mcp.exe"
    else:
        command = upstream_root / ".venv" / "bin" / "blender-mcp"

    if not command.is_file():
        raise FileNotFoundError(
            f"Blender-MCP entry point was not found at {command}. Run setup.ps1 first."
        )
    return command


async def run_smoke_test() -> None:
    repro_root = Path(__file__).resolve().parents[1]
    upstream_root = repro_root / "upstream"
    command = resolve_server_command(upstream_root)
    child_env = os.environ.copy()
    child_env.update(
        {
            "BLENDER_HOST": "localhost",
            "BLENDER_PORT": "9876",
            "DISABLE_TELEMETRY": "true",
            "PYTHONUTF8": "1",
        }
    )

    server = StdioServerParameters(
        command=str(command),
        args=[],
        cwd=upstream_root,
        env=child_env,
    )

    async with asyncio.timeout(SMOKE_TIMEOUT_SECONDS):
        async with stdio_client(server) as (read_stream, write_stream):
            async with ClientSession(
                read_stream,
                write_stream,
                read_timeout_seconds=REQUEST_TIMEOUT,
            ) as session:
                initialize_result = await session.initialize()
                tools_result = await session.list_tools()

    if initialize_result.serverInfo.name != EXPECTED_SERVER_NAME:
        raise RuntimeError(
            "Unexpected MCP server name: "
            f"{initialize_result.serverInfo.name!r} != {EXPECTED_SERVER_NAME!r}"
        )

    package_version = version("blender-mcp")
    if package_version != EXPECTED_PACKAGE_VERSION:
        raise RuntimeError(
            f"Unexpected blender-mcp version: {package_version!r} "
            f"!= {EXPECTED_PACKAGE_VERSION!r}"
        )

    tool_names = {tool.name for tool in tools_result.tools}
    missing = EXPECTED_TOOLS - tool_names
    if missing:
        raise RuntimeError(f"MCP server is missing expected tools: {sorted(missing)}")

    print(
        json.dumps(
            {
                "server_name": initialize_result.serverInfo.name,
                "blender_mcp_version": package_version,
                "mcp_server_version": initialize_result.serverInfo.version,
                "tool_count": len(tool_names),
                "expected_tools": sorted(EXPECTED_TOOLS),
                "status": "ok",
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(run_smoke_test())
