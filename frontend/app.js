// Foundry Agent Playground - Frontend Logic

const API_BASE = '';

// State
let state = {
    messages: [],
    model: '',
    systemPrompt: '',
    mcpServers: [],
    isStreaming: false,
    editingServerId: null,
};

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
    initUI();
    loadModels();
    loadMCPServers();
});

function initUI() {
    // Sidebar toggle
    document.getElementById('toggleSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.add('hidden');
    });
    document.getElementById('openSidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('hidden');
    });

    // Chat input
    const chatInput = document.getElementById('chatInput');
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
    chatInput.addEventListener('input', autoResize);
    document.getElementById('sendBtn').addEventListener('click', sendMessage);

    // MCP Modal
    document.getElementById('addMcpBtn').addEventListener('click', () => openMcpModal());
    document.getElementById('closeMcpModal').addEventListener('click', closeMcpModal);
    document.getElementById('cancelMcpModal').addEventListener('click', closeMcpModal);
    document.getElementById('saveMcpModal').addEventListener('click', saveMcpServer);
    document.getElementById('mcpTransport').addEventListener('change', toggleTransportFields);
    document.getElementById('mcpAuthType').addEventListener('change', toggleAuthFields);
}

function autoResize() {
    const el = document.getElementById('chatInput');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
}

// --- Models ---

async function loadModels() {
    try {
        const res = await fetch(`${API_BASE}/api/models`);
        const data = await res.json();
        const select = document.getElementById('modelSelect');
        select.innerHTML = '';
        if (data.models.length === 0) {
            select.innerHTML = '<option value="">モデルが見つかりません</option>';
            return;
        }
        data.models.forEach(m => {
            const opt = document.createElement('option');
            opt.value = m.id;
            opt.textContent = m.name;
            if (m.id === data.default) opt.selected = true;
            select.appendChild(opt);
        });
        state.model = select.value;
        select.addEventListener('change', () => { state.model = select.value; });
    } catch (e) {
        console.error('Failed to load models:', e);
        document.getElementById('modelSelect').innerHTML = '<option value="">エラー: モデル取得失敗</option>';
    }
}

// --- Chat ---

async function sendMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text || state.isStreaming) return;

    const model = document.getElementById('modelSelect').value;
    if (!model) {
        alert('モデルを選択してください');
        return;
    }

    // Add user message
    state.messages.push({ role: 'user', content: text });
    appendMessage('user', text);
    input.value = '';
    input.style.height = 'auto';

    // Remove welcome message
    const welcome = document.querySelector('.welcome-message');
    if (welcome) welcome.remove();

    state.isStreaming = true;
    document.getElementById('sendBtn').disabled = true;

    // Show typing indicator
    const typingEl = appendTyping();

    try {
        const res = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                messages: state.messages,
                model: model,
                system_prompt: document.getElementById('systemPrompt').value,
            }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let assistantContent = '';
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const event = JSON.parse(data);
                    handleStreamEvent(event, typingEl);
                    if (event.type === 'content') {
                        assistantContent = event.content;
                    }
                } catch (e) {
                    // Skip malformed JSON
                }
            }
        }

        // Remove typing indicator
        typingEl.remove();

        // Add assistant message to state
        if (assistantContent) {
            state.messages.push({ role: 'assistant', content: assistantContent });
        }
    } catch (e) {
        typingEl.remove();
        appendMessage('error', `エラー: ${e.message}`);
    }

    state.isStreaming = false;
    document.getElementById('sendBtn').disabled = false;
}

function handleStreamEvent(event, typingEl) {
    switch (event.type) {
        case 'content':
            typingEl.remove();
            appendMessage('assistant', event.content);
            break;
        case 'tool_call':
            appendMessage('tool-call', `🔧 Tool Call: ${event.tool_name}\n${JSON.stringify(event.arguments, null, 2)}`);
            break;
        case 'tool_result':
            appendMessage('tool-call', `✅ Result: ${event.tool_name}\n${typeof event.result === 'string' ? event.result : JSON.stringify(event.result, null, 2)}`);
            break;
        case 'image':
            appendImageMessage(event.mimeType || 'image/png', event.data);
            break;
        case 'vegalite':
            appendVegaLiteMessage(event.spec);
            break;
        case 'error':
            typingEl.remove();
            appendMessage('error', event.content);
            break;
    }
}

function appendMessage(type, content) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `message ${type}`;

    if (type === 'tool-call') {
        const label = document.createElement('div');
        label.className = 'tool-label';
        const lines = content.split('\n');
        label.textContent = lines[0];
        div.appendChild(label);
        if (lines.length > 1) {
            const body = document.createElement('div');
            body.textContent = lines.slice(1).join('\n');
            div.appendChild(body);
        }
    } else {
        div.textContent = content;
    }

    container.appendChild(div);
    scrollToBottom();
    return div;
}

function appendImageMessage(mimeType, base64Data) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'message assistant image-message';
    const img = document.createElement('img');
    img.src = `data:${mimeType};base64,${base64Data}`;
    img.alt = 'Chart';
    img.className = 'chat-image';
    div.appendChild(img);
    container.appendChild(div);
    scrollToBottom();
    return div;
}

function appendVegaLiteMessage(spec) {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'message assistant vega-message';

    const isMap = isMapSpec(spec);

    const chartDiv = document.createElement('div');
    chartDiv.className = 'vega-container';

    let viewport = null;
    if (isMap) {
        // Wrap maps in a pan/zoom viewport.
        viewport = document.createElement('div');
        viewport.className = 'vega-viewport';
        viewport.appendChild(chartDiv);
        div.appendChild(viewport);
        const hint = document.createElement('div');
        hint.className = 'vega-hint';
        hint.textContent = 'スクロールで拡大・縮小 / ドラッグで移動 / ダブルクリックでリセット';
        div.appendChild(hint);
    } else {
        div.appendChild(chartDiv);
    }
    container.appendChild(div);

    if (typeof vegaEmbed === 'undefined') {
        chartDiv.textContent = 'Vega-Lite ライブラリの読み込みに失敗しました';
        scrollToBottom();
        return div;
    }

    // For non-map charts, make them responsive to the container width.
    // Maps keep their intrinsic size so pan/zoom math stays stable.
    const embedSpec = Object.assign({}, spec);
    if (!isMap && embedSpec.width !== undefined && !embedSpec.autosize) {
        embedSpec.width = 'container';
    }

    vegaEmbed(chartDiv, embedSpec, {
        actions: false,
        mode: 'vega-lite',
        // SVG stays crisp when scaled via CSS transform (needed for map zoom).
        renderer: isMap ? 'svg' : 'canvas',
    }).then(() => {
        if (isMap && viewport) {
            attachPanZoom(viewport, chartDiv);
        }
    }).catch((e) => {
        chartDiv.textContent = `チャート描画エラー: ${e.message}`;
    });

    scrollToBottom();
    return div;
}

// Detect a geographic map spec (has a projection or a geoshape mark).
function isMapSpec(spec) {
    if (!spec || typeof spec !== 'object') return false;
    if (spec.projection) return true;
    const markIsGeoshape = (m) => m === 'geoshape' || (m && m.type === 'geoshape');
    if (markIsGeoshape(spec.mark)) return true;
    if (Array.isArray(spec.layer)) {
        return spec.layer.some((l) => l && (l.projection || markIsGeoshape(l.mark)));
    }
    return false;
}

// Add wheel-zoom (toward cursor) and drag-pan to a viewport by CSS-transforming
// the target element. Double-click resets.
function attachPanZoom(viewport, target) {
    let scale = 1;
    let tx = 0;
    let ty = 0;
    target.style.transformOrigin = '0 0';
    viewport.style.cursor = 'grab';

    const apply = () => {
        target.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    };

    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.0015);
        const newScale = Math.min(30, Math.max(1, scale * factor));
        const k = newScale / scale;
        // Keep the point under the cursor fixed while zooming.
        tx = mx - k * (mx - tx);
        ty = my - k * (my - ty);
        scale = newScale;
        if (scale === 1) { tx = 0; ty = 0; }
        apply();
    }, { passive: false });

    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    viewport.addEventListener('pointerdown', (e) => {
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        viewport.setPointerCapture(e.pointerId);
        viewport.style.cursor = 'grabbing';
    });
    viewport.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        tx += e.clientX - lastX;
        ty += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        apply();
    });
    const endDrag = () => { dragging = false; viewport.style.cursor = 'grab'; };
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    viewport.addEventListener('dblclick', () => { scale = 1; tx = 0; ty = 0; apply(); });
}

function appendTyping() {
    const container = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'typing-indicator';
    div.textContent = '考え中...';
    container.appendChild(div);
    scrollToBottom();
    return div;
}

function scrollToBottom() {
    const container = document.getElementById('chatContainer');
    container.scrollTop = container.scrollHeight;
}

// --- MCP Server Management ---

async function loadMCPServers() {
    try {
        const res = await fetch(`${API_BASE}/api/mcp/servers`);
        const data = await res.json();
        state.mcpServers = data.servers;
        renderMCPServers();
    } catch (e) {
        console.error('Failed to load MCP servers:', e);
    }
}

function renderMCPServers() {
    const container = document.getElementById('mcpServerList');
    if (state.mcpServers.length === 0) {
        container.innerHTML = '<div class="mcp-server-status">MCPサーバーが設定されていません</div>';
        return;
    }

    container.innerHTML = state.mcpServers.map(s => `
        <div class="mcp-server-item">
            <div class="mcp-server-item-header">
                <span class="mcp-server-name">${escapeHtml(s.name)}</span>
                <span class="mcp-server-type">${s.transport === 'stdio' ? 'ローカル' : 'リモート'}</span>
            </div>
            <div class="mcp-server-actions">
                <button class="btn-small" onclick="testMcpServer('${s.id}')">テスト</button>
                <button class="btn-small" onclick="editMcpServer('${s.id}')">編集</button>
                <button class="btn-danger" onclick="deleteMcpServer('${s.id}')">削除</button>
            </div>
        </div>
    `).join('');

    updateToolBadges();
}

async function updateToolBadges() {
    // Show enabled server count in header
    const enabled = state.mcpServers.filter(s => s.enabled);
    const el = document.getElementById('activeTools');
    if (enabled.length > 0) {
        el.innerHTML = enabled.map(s =>
            `<span class="tool-badge">${escapeHtml(s.name)}</span>`
        ).join('');
    } else {
        el.innerHTML = '';
    }
}

function openMcpModal(serverId = null) {
    state.editingServerId = serverId;
    const modal = document.getElementById('mcpModal');
    const title = document.getElementById('mcpModalTitle');

    if (serverId) {
        const server = state.mcpServers.find(s => s.id === serverId);
        if (!server) return;
        title.textContent = 'MCPサーバーを編集';
        document.getElementById('mcpName').value = server.name;
        document.getElementById('mcpTransport').value = server.transport;
        document.getElementById('mcpCommand').value = server.command || '';
        document.getElementById('mcpArgs').value = (server.args || []).join(',');
        document.getElementById('mcpUrl').value = server.url || '';
        document.getElementById('mcpAuthType').value = server.auth_type || 'none';
        document.getElementById('mcpAuthScope').value = server.auth_scope || 'https://api.fabric.microsoft.com/.default';
        document.getElementById('mcpHeaders').value = server.headers ? JSON.stringify(server.headers, null, 2) : '';
    } else {
        title.textContent = 'MCPサーバーを追加';
        document.getElementById('mcpName').value = '';
        document.getElementById('mcpTransport').value = 'stdio';
        document.getElementById('mcpCommand').value = '';
        document.getElementById('mcpArgs').value = '';
        document.getElementById('mcpUrl').value = '';
        document.getElementById('mcpAuthType').value = 'none';
        document.getElementById('mcpAuthScope').value = 'https://api.fabric.microsoft.com/.default';
        document.getElementById('mcpHeaders').value = '';
    }

    toggleTransportFields();
    toggleAuthFields();
    modal.classList.add('active');
}

function closeMcpModal() {
    document.getElementById('mcpModal').classList.remove('active');
    state.editingServerId = null;
}

function toggleTransportFields() {
    const transport = document.getElementById('mcpTransport').value;
    document.getElementById('stdioFields').style.display = transport === 'stdio' ? 'block' : 'none';
    document.getElementById('httpFields').style.display = (transport === 'sse' || transport === 'streamable_http') ? 'block' : 'none';
}

function toggleAuthFields() {
    const authType = document.getElementById('mcpAuthType').value;
    document.getElementById('authScopeField').style.display = authType === 'azure_cli' ? 'block' : 'none';
}

async function saveMcpServer() {
    const name = document.getElementById('mcpName').value.trim();
    const transport = document.getElementById('mcpTransport').value;

    if (!name) {
        alert('名前を入力してください');
        return;
    }

    const payload = { name, transport, enabled: true };

    if (transport === 'stdio') {
        payload.command = document.getElementById('mcpCommand').value.trim();
        payload.args = document.getElementById('mcpArgs').value.split(',').map(a => a.trim()).filter(Boolean);
        if (!payload.command) {
            alert('コマンドを入力してください');
            return;
        }
    } else {
        payload.url = document.getElementById('mcpUrl').value.trim();
        payload.auth_type = document.getElementById('mcpAuthType').value;
        if (payload.auth_type === 'azure_cli') {
            payload.auth_scope = document.getElementById('mcpAuthScope').value.trim() || 'https://api.fabric.microsoft.com/.default';
        }
        const headersStr = document.getElementById('mcpHeaders').value.trim();
        if (headersStr) {
            try {
                payload.headers = JSON.parse(headersStr);
            } catch (e) {
                alert('ヘッダーのJSONが不正です');
                return;
            }
        }
        if (!payload.url) {
            alert('URLを入力してください');
            return;
        }
    }

    try {
        let res;
        if (state.editingServerId) {
            res = await fetch(`${API_BASE}/api/mcp/servers/${state.editingServerId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } else {
            res = await fetch(`${API_BASE}/api/mcp/servers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        }

        if (res.ok) {
            closeMcpModal();
            await loadMCPServers();
        } else {
            const err = await res.json();
            alert(`エラー: ${err.detail || 'サーバーの保存に失敗しました'}`);
        }
    } catch (e) {
        alert(`エラー: ${e.message}`);
    }
}

function editMcpServer(serverId) {
    openMcpModal(serverId);
}

async function deleteMcpServer(serverId) {
    if (!confirm('このMCPサーバーを削除しますか?')) return;

    try {
        const res = await fetch(`${API_BASE}/api/mcp/servers/${serverId}`, { method: 'DELETE' });
        if (res.ok) {
            await loadMCPServers();
        }
    } catch (e) {
        alert(`削除エラー: ${e.message}`);
    }
}

async function testMcpServer(serverId) {
    const server = state.mcpServers.find(s => s.id === serverId);
    if (!server) return;

    try {
        const res = await fetch(`${API_BASE}/api/mcp/servers/${serverId}/tools`);
        const data = await res.json();
        if (data.tools && data.tools.length > 0) {
            alert(`✅ 接続成功!\n\nツール (${data.tools.length}個):\n${data.tools.map(t => `• ${t.name}`).join('\n')}`);
        } else {
            alert('⚠️ 接続成功しましたが、ツールが見つかりませんでした。');
        }
    } catch (e) {
        alert(`❌ 接続失敗: ${e.message}`);
    }
}

// --- Utilities ---

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
