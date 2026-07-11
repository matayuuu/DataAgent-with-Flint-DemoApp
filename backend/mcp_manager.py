"""MCP Server Manager - handles connecting to local (stdio) and remote (SSE/Streamable HTTP) MCP servers."""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from azure.identity import DefaultAzureCredential
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.sse import sse_client
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger(__name__)

CONFIG_FILE = Path(__file__).parent.parent / "mcp_servers.json"
EXAMPLE_CONFIG_FILE = Path(__file__).parent.parent / "mcp_servers.example.json"


class TransportType(str, Enum):
    STDIO = "stdio"
    SSE = "sse"
    STREAMABLE_HTTP = "streamable_http"


class AuthType(str, Enum):
    NONE = "none"
    AZURE_CLI = "azure_cli"


# Cached credential instance
_azure_credential: DefaultAzureCredential | None = None


def _get_azure_credential() -> DefaultAzureCredential:
    global _azure_credential
    if _azure_credential is None:
        _azure_credential = DefaultAzureCredential()
    return _azure_credential


def _get_azure_token(scope: str) -> str:
    """Get a bearer token from az login for the given scope."""
    credential = _get_azure_credential()
    token = credential.get_token(scope)
    return token.token


@dataclass
class MCPServerConfig:
    id: str
    name: str
    transport: TransportType
    # For stdio
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    # For SSE / Streamable HTTP
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    # Authentication
    auth_type: AuthType = AuthType.NONE
    auth_scope: str = "https://api.fabric.microsoft.com/.default"
    # State
    enabled: bool = True


@dataclass
class MCPServerState:
    config: MCPServerConfig
    tools: list[dict[str, Any]] = field(default_factory=list)
    connected: bool = False


class MCPManager:
    def __init__(self):
        self.servers: dict[str, MCPServerConfig] = {}
        self._load_config()

    def _load_config(self):
        # Fall back to the checked-in example when no local config exists
        # (e.g. a fresh clone). The local mcp_servers.json is user-specific.
        source = CONFIG_FILE if CONFIG_FILE.exists() else EXAMPLE_CONFIG_FILE
        if source.exists():
            try:
                data = json.loads(source.read_text(encoding="utf-8"))
                for item in data:
                    config = MCPServerConfig(
                        id=item["id"],
                        name=item["name"],
                        transport=TransportType(item["transport"]),
                        command=item.get("command", ""),
                        args=item.get("args", []),
                        env=item.get("env", {}),
                        url=item.get("url", ""),
                        headers=item.get("headers", {}),
                        auth_type=AuthType(item.get("auth_type", "none")),
                        auth_scope=item.get("auth_scope", "https://api.fabric.microsoft.com/.default"),
                        enabled=item.get("enabled", True),
                    )
                    self.servers[config.id] = config
            except Exception as e:
                logger.error(f"Failed to load MCP config: {e}")

    def _save_config(self):
        data = []
        for config in self.servers.values():
            data.append({
                "id": config.id,
                "name": config.name,
                "transport": config.transport.value,
                "command": config.command,
                "args": config.args,
                "env": config.env,
                "url": config.url,
                "headers": config.headers,
                "auth_type": config.auth_type.value,
                "auth_scope": config.auth_scope,
                "enabled": config.enabled,
            })
        CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def add_server(self, config: MCPServerConfig) -> MCPServerConfig:
        self.servers[config.id] = config
        self._save_config()
        return config

    def update_server(self, server_id: str, updates: dict) -> MCPServerConfig | None:
        if server_id not in self.servers:
            return None
        config = self.servers[server_id]
        for key, value in updates.items():
            if hasattr(config, key) and key != "id":
                setattr(config, key, value)
        self._save_config()
        return config

    def delete_server(self, server_id: str) -> bool:
        if server_id in self.servers:
            del self.servers[server_id]
            self._save_config()
            return True
        return False

    def get_servers(self) -> list[MCPServerConfig]:
        return list(self.servers.values())

    def get_server(self, server_id: str) -> MCPServerConfig | None:
        return self.servers.get(server_id)

    async def list_tools(self, server_id: str) -> list[dict[str, Any]]:
        """Connect to an MCP server and list its available tools."""
        config = self.servers.get(server_id)
        if not config or not config.enabled:
            return []

        try:
            if config.transport == TransportType.STDIO:
                return await self._list_tools_stdio(config)
            elif config.transport == TransportType.SSE:
                return await self._list_tools_sse(config)
            else:
                return await self._list_tools_streamable_http(config)
        except Exception as e:
            logger.error(f"Failed to list tools from {config.name}: {e}")
            return []

    def _resolve_headers(self, config: MCPServerConfig) -> dict[str, str]:
        """Resolve headers including auth token if needed."""
        headers = dict(config.headers)
        if config.auth_type == AuthType.AZURE_CLI:
            token = _get_azure_token(config.auth_scope)
            headers["Authorization"] = f"Bearer {token}"
        return headers

    async def _list_tools_stdio(self, config: MCPServerConfig) -> list[dict[str, Any]]:
        server_params = StdioServerParameters(
            command=config.command,
            args=config.args,
            env=config.env if config.env else None,
        )
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                return [
                    {
                        "name": tool.name,
                        "description": tool.description or "",
                        "inputSchema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
                    }
                    for tool in result.tools
                ]

    async def _list_tools_sse(self, config: MCPServerConfig) -> list[dict[str, Any]]:
        headers = self._resolve_headers(config)
        async with sse_client(config.url, headers=headers) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                return [
                    {
                        "name": tool.name,
                        "description": tool.description or "",
                        "inputSchema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
                    }
                    for tool in result.tools
                ]

    async def _list_tools_streamable_http(self, config: MCPServerConfig) -> list[dict[str, Any]]:
        headers = self._resolve_headers(config)
        async with streamablehttp_client(config.url, headers=headers) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                return [
                    {
                        "name": tool.name,
                        "description": tool.description or "",
                        "inputSchema": tool.inputSchema if hasattr(tool, "inputSchema") else {},
                    }
                    for tool in result.tools
                ]

    async def call_tool(self, server_id: str, tool_name: str, arguments: dict) -> dict[str, Any]:
        """Call a tool on the specified MCP server.

        Returns {"text": str, "images": [...]} on success, or {"error": str} on failure.
        """
        config = self.servers.get(server_id)
        if not config or not config.enabled:
            return {"error": f"Server {server_id} not found or disabled"}

        try:
            if config.transport == TransportType.STDIO:
                return await self._call_tool_stdio(config, tool_name, arguments)
            elif config.transport == TransportType.SSE:
                return await self._call_tool_sse(config, tool_name, arguments)
            else:
                return await self._call_tool_streamable_http(config, tool_name, arguments)
        except Exception as e:
            logger.error(f"Failed to call tool {tool_name} on {config.name}: {e}")
            return {"error": str(e)}

    async def _call_tool_stdio(self, config: MCPServerConfig, tool_name: str, arguments: dict) -> Any:
        server_params = StdioServerParameters(
            command=config.command,
            args=config.args,
            env=config.env if config.env else None,
        )
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
                return self._format_tool_result(result)

    async def _call_tool_sse(self, config: MCPServerConfig, tool_name: str, arguments: dict) -> Any:
        headers = self._resolve_headers(config)
        async with sse_client(config.url, headers=headers) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
                return self._format_tool_result(result)

    async def _call_tool_streamable_http(self, config: MCPServerConfig, tool_name: str, arguments: dict) -> Any:
        headers = self._resolve_headers(config)
        async with streamablehttp_client(config.url, headers=headers) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
                return self._format_tool_result(result)

    def _format_tool_result(self, result) -> dict[str, Any]:
        """Format MCP tool result into text plus any image artifacts.

        Returns a dict: {"text": str, "images": [{"mimeType": str, "data": str}]}
        """
        parts: list[str] = []
        images: list[dict[str, str]] = []
        for content in result.content:
            ctype = getattr(content, "type", None)
            if ctype == "image" or (hasattr(content, "data") and hasattr(content, "mimeType")):
                images.append({
                    "mimeType": getattr(content, "mimeType", "image/png"),
                    "data": getattr(content, "data", ""),
                })
            elif hasattr(content, "text"):
                parts.append(content.text)
            else:
                parts.append(str(content))
        return {"text": "\n".join(parts), "images": images}

    async def get_all_tools(self) -> list[dict[str, Any]]:
        """Get tools from all enabled MCP servers, prefixed with server id."""
        all_tools = []
        for server_id, config in self.servers.items():
            if not config.enabled:
                continue
            tools = await self.list_tools(server_id)
            for tool in tools:
                all_tools.append({
                    "server_id": server_id,
                    "server_name": config.name,
                    "name": tool["name"],
                    "full_name": f"{server_id}__{tool['name']}",
                    "description": tool.get("description", ""),
                    "inputSchema": tool.get("inputSchema", {}),
                })
        return all_tools
