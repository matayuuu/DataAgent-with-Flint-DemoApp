"""FastAPI application - Foundry Agent Playground."""

import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.agent import AgentRunner
from backend.config import DEFAULT_MODEL
from backend.mcp_manager import MCPManager, MCPServerConfig, TransportType, AuthType

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

mcp_manager = MCPManager()
agent_runner = AgentRunner(mcp_manager)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Foundry Agent Playground starting...")
    yield
    logger.info("Shutting down...")


app = FastAPI(title="Foundry Agent Playground", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Models ---


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str = DEFAULT_MODEL
    system_prompt: str = ""
    chart_backend: str = "vegalite"


class MCPServerCreate(BaseModel):
    name: str
    transport: str  # "stdio", "sse", or "streamable_http"
    command: str = ""
    args: list[str] = []
    env: dict[str, str] = {}
    url: str = ""
    headers: dict[str, str] = {}
    auth_type: str = "none"  # "none" or "azure_cli"
    auth_scope: str = "https://api.fabric.microsoft.com/.default"
    enabled: bool = True


class MCPServerUpdate(BaseModel):
    name: str | None = None
    transport: str | None = None
    command: str | None = None
    args: list[str] | None = None
    env: dict[str, str] | None = None
    url: str | None = None
    headers: dict[str, str] | None = None
    auth_type: str | None = None
    auth_scope: str | None = None
    enabled: bool | None = None


# --- API Endpoints ---


@app.get("/api/models")
async def list_models():
    """List available models from the Foundry project."""
    models = await agent_runner.list_models()
    return {"models": models, "default": DEFAULT_MODEL}


@app.post("/api/chat")
async def chat(request: ChatRequest):
    """Chat with the agent. Returns streamed JSON events."""
    messages = [{"role": m.role, "content": m.content} for m in request.messages]

    async def event_stream():
        async for event in agent_runner.chat(
            messages=messages,
            model=request.model,
            system_prompt=request.system_prompt,
            chart_backend=request.chart_backend,
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- MCP Server Management ---


@app.get("/api/mcp/servers")
async def list_mcp_servers():
    """List all configured MCP servers."""
    servers = mcp_manager.get_servers()
    return {
        "servers": [
            {
                "id": s.id,
                "name": s.name,
                "transport": s.transport.value,
                "command": s.command,
                "args": s.args,
                "env": s.env,
                "url": s.url,
                "headers": s.headers,
                "auth_type": s.auth_type.value,
                "auth_scope": s.auth_scope,
                "enabled": s.enabled,
            }
            for s in servers
        ]
    }


@app.post("/api/mcp/servers")
async def add_mcp_server(server: MCPServerCreate):
    """Add a new MCP server configuration."""
    config = MCPServerConfig(
        id=str(uuid.uuid4())[:8],
        name=server.name,
        transport=TransportType(server.transport),
        command=server.command,
        args=server.args,
        env=server.env,
        url=server.url,
        headers=server.headers,
        auth_type=AuthType(server.auth_type),
        auth_scope=server.auth_scope,
        enabled=server.enabled,
    )
    result = mcp_manager.add_server(config)
    return {"id": result.id, "name": result.name}


@app.put("/api/mcp/servers/{server_id}")
async def update_mcp_server(server_id: str, updates: MCPServerUpdate):
    """Update an MCP server configuration."""
    update_dict = {k: v for k, v in updates.model_dump().items() if v is not None}
    if "transport" in update_dict:
        update_dict["transport"] = TransportType(update_dict["transport"])
    if "auth_type" in update_dict:
        update_dict["auth_type"] = AuthType(update_dict["auth_type"])
    result = mcp_manager.update_server(server_id, update_dict)
    if result is None:
        raise HTTPException(status_code=404, detail="Server not found")
    return {"id": result.id, "name": result.name}


@app.delete("/api/mcp/servers/{server_id}")
async def delete_mcp_server(server_id: str):
    """Delete an MCP server configuration."""
    success = mcp_manager.delete_server(server_id)
    if not success:
        raise HTTPException(status_code=404, detail="Server not found")
    return {"ok": True}


@app.get("/api/mcp/servers/{server_id}/tools")
async def list_server_tools(server_id: str):
    """List tools from a specific MCP server."""
    config = mcp_manager.get_server(server_id)
    if config is None:
        raise HTTPException(status_code=404, detail="Server not found")
    tools = await mcp_manager.list_tools(server_id)
    return {"tools": tools}


@app.get("/api/mcp/tools")
async def list_all_tools():
    """List all tools from all enabled MCP servers."""
    tools = await mcp_manager.get_all_tools()
    return {"tools": tools}


# Serve frontend static files
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")
