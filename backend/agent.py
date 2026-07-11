"""Agent logic - implements the chat loop with MCP tool execution."""

import json
import logging
from typing import Any, AsyncGenerator

from azure.identity import DefaultAzureCredential
from azure.ai.projects import AIProjectClient

from backend.config import PROJECT_ENDPOINT
from backend.mcp_manager import MCPManager

logger = logging.getLogger(__name__)


class AgentRunner:
    def __init__(self, mcp_manager: MCPManager):
        self.mcp_manager = mcp_manager
        self._project_client: AIProjectClient | None = None
        self._openai_client = None

    def _get_project_client(self) -> AIProjectClient:
        if self._project_client is None:
            self._project_client = AIProjectClient(
                endpoint=PROJECT_ENDPOINT,
                credential=DefaultAzureCredential(),
            )
        return self._project_client

    def _get_openai_client(self):
        if self._openai_client is None:
            project = self._get_project_client()
            self._openai_client = project.get_openai_client()
        return self._openai_client

    async def list_models(self) -> list[dict[str, str]]:
        """List available models from the Foundry project.

        Foundry project endpoints do not support the OpenAI ``models.list``
        route, so we enumerate the project's model deployments instead and
        fall back to the OpenAI route / a static list if that fails.
        """
        # Preferred: enumerate the project's model deployments. This is what
        # works against Foundry project endpoints.
        try:
            client = self._get_project_client()
            result = []
            for dep in client.deployments.list():
                name = getattr(dep, "name", None)
                if not name:
                    continue
                model_name = getattr(dep, "model_name", "") or ""
                # Skip embedding deployments - they can't be used for chat.
                if "embedding" in name.lower() or "embedding" in model_name.lower():
                    continue
                result.append({"id": name, "name": name})
            if result:
                return sorted(result, key=lambda x: x["name"])
        except Exception as e:
            logger.error(f"Failed to list deployments: {e}", exc_info=True)

        # Secondary: try the OpenAI models route (works on some resources).
        try:
            client = self._get_openai_client()
            models = client.models.list()
            result = []
            for model in models:
                result.append({
                    "id": model.id,
                    "name": model.id,
                })
            if result:
                return sorted(result, key=lambda x: x["name"])
        except Exception as e:
            logger.error(f"Failed to list models via API: {e}", exc_info=True)

        # Fallback: return common Foundry models including the configured default
        logger.info("Using fallback model list")
        fallback = [
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4.1-nano",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.5",
        ]
        from backend.config import DEFAULT_MODEL
        if DEFAULT_MODEL and DEFAULT_MODEL not in fallback:
            fallback.insert(0, DEFAULT_MODEL)
        return [{"id": m, "name": m} for m in fallback]

    async def chat(
        self,
        messages: list[dict[str, Any]],
        model: str,
        system_prompt: str = "",
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Run a chat turn with MCP tool execution loop. Yields streamed events."""
        client = self._get_openai_client()

        # Get available MCP tools
        mcp_tools = await self.mcp_manager.get_all_tools()
        openai_tools = self._build_openai_tools(mcp_tools)

        # Build messages with system prompt
        full_messages = []
        combined_system = system_prompt or ""

        # If a chart tool is available, guide the model to produce a Vega-Lite
        # spec that the UI renders as an interactive chart (vega-embed).
        tool_full_names = {t["full_name"] for t in mcp_tools}
        compile_tools = [n for n in tool_full_names if n.endswith("__compile_chart")]
        if compile_tools:
            chart_hint = (
                "When the user asks for a chart, graph, MAP (地図/マップ), or choropleth, "
                "call the `compile_chart` tool with `backend` set to \"vegalite\". It returns "
                "a Vega-Lite specification that this playground renders as an interactive chart. "
                "Vega-Lite natively supports geographic maps: use chartType \"Map\" for a "
                "bubble/symbol map (channels: longitude, latitude, color, size) and \"Choropleth\" "
                "for filled regions (channels: id, color, detail). "
                "Do NOT use `render_chart` (static PNG) or `create_chart_view` (text only) for display."
            )
            combined_system = (combined_system + "\n\n" + chart_hint).strip()

        if combined_system:
            full_messages.append({"role": "system", "content": combined_system})
        full_messages.extend(messages)

        # Agent loop - keep going until no more tool calls
        max_iterations = 10
        for _ in range(max_iterations):
            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=full_messages,
                    tools=openai_tools if openai_tools else None,
                )
            except Exception as e:
                yield {"type": "error", "content": f"Model error: {str(e)}"}
                return

            choice = response.choices[0]
            message = choice.message

            # If no tool calls, return the final response
            if not message.tool_calls:
                yield {"type": "content", "content": message.content or ""}
                return

            # Process tool calls
            full_messages.append({
                "role": "assistant",
                "content": message.content,
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in message.tool_calls
                ],
            })

            for tool_call in message.tool_calls:
                func_name = tool_call.function.name
                try:
                    func_args = json.loads(tool_call.function.arguments)
                except json.JSONDecodeError:
                    func_args = {}

                yield {
                    "type": "tool_call",
                    "tool_name": func_name,
                    "arguments": func_args,
                }

                # Route to MCP server
                result = await self._execute_mcp_tool(func_name, func_args, mcp_tools)
                result_text = result.get("text", "")
                images = result.get("images", [])
                if result.get("error"):
                    result_text = f"Error: {result['error']}"

                # Detect a Vega-Lite spec (from Flint compile_chart) so the
                # UI can render it as an interactive chart via vega-embed.
                vegalite_spec = self._extract_vegalite_spec(result_text)

                yield {
                    "type": "tool_result",
                    "tool_name": func_name,
                    "result": result_text[:500] if len(result_text) > 500 else result_text,
                }

                if vegalite_spec is not None:
                    yield {
                        "type": "vegalite",
                        "tool_name": func_name,
                        "spec": vegalite_spec,
                    }

                # Emit any image artifacts (e.g. charts) for the UI to render
                for img in images:
                    yield {
                        "type": "image",
                        "tool_name": func_name,
                        "mimeType": img.get("mimeType", "image/png"),
                        "data": img.get("data", ""),
                    }

                # Text sent back to the model. Summarize artifacts instead of
                # dumping large specs/binaries so the model stays focused.
                if vegalite_spec is not None:
                    model_content = (
                        "[An interactive Vega-Lite chart was rendered and is now shown to "
                        "the user. Briefly describe the chart; do not repeat the spec.]"
                    )
                elif images and not result_text.strip():
                    model_content = f"[{len(images)} image(s) rendered and shown to the user]"
                elif images:
                    model_content = f"{result_text}\n[{len(images)} image(s) rendered and shown to the user]"
                else:
                    model_content = result_text

                full_messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": model_content,
                })

        yield {"type": "error", "content": "Max tool call iterations reached"}

    def _extract_vegalite_spec(self, text: str) -> dict | None:
        """Parse a Flint compile_chart result and return the Vega-Lite spec.

        Returns the Vega-Lite spec dict when the text is JSON with
        backend == "vegalite" and a `spec`; otherwise None.
        """
        if not text or "vegalite" not in text:
            return None
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return None
        if isinstance(parsed, dict) and parsed.get("backend") == "vegalite":
            spec = parsed.get("spec")
            if isinstance(spec, dict):
                return spec
        return None

    def _build_openai_tools(self, mcp_tools: list[dict]) -> list[dict]:
        """Convert MCP tools to OpenAI function calling format."""
        tools = []
        for tool in mcp_tools:
            schema = tool.get("inputSchema", {})
            # Ensure schema has proper structure
            if not schema:
                schema = {"type": "object", "properties": {}}

            tools.append({
                "type": "function",
                "function": {
                    "name": tool["full_name"],
                    "description": f"[{tool['server_name']}] {tool['description']}",
                    "parameters": schema,
                },
            })
        return tools

    async def _execute_mcp_tool(
        self, full_name: str, arguments: dict, mcp_tools: list[dict]
    ) -> dict[str, Any]:
        """Execute a tool call by routing to the appropriate MCP server.

        Returns {"text": str, "images": [...]} or {"error": str}.
        """
        # Find the tool mapping
        for tool in mcp_tools:
            if tool["full_name"] == full_name:
                server_id = tool["server_id"]
                tool_name = tool["name"]
                return await self.mcp_manager.call_tool(server_id, tool_name, arguments)

        return {"text": f"Tool {full_name} not found", "images": []}
