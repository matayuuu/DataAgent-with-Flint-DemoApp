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

    // Per-turn context: all tool activity for this turn is grouped into a
    // single collapsible container (created lazily on first tool event).
    const turnCtx = { group: null, typingEl };

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
                    handleStreamEvent(event, turnCtx);
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

function handleStreamEvent(event, turnCtx) {
    const typingEl = turnCtx.typingEl;
    switch (event.type) {
        case 'content':
            typingEl.remove();
            appendMessage('assistant', event.content);
            break;
        case 'tool_call': {
            const group = ensureActivityGroup(turnCtx);
            appendActivityItem(group, {
                title: `🔧 ${event.tool_name} を実行`,
                variant: 'tool-call',
                bodyText: JSON.stringify(event.arguments, null, 2),
            });
            keepTypingLast(turnCtx);
            break;
        }
        case 'tool_result': {
            const group = ensureActivityGroup(turnCtx);
            const txt = typeof event.result === 'string'
                ? event.result
                : JSON.stringify(event.result, null, 2);
            appendActivityItem(group, {
                title: `✅ ${event.tool_name} の結果`,
                variant: 'tool-result',
                bodyText: txt,
            });
            keepTypingLast(turnCtx);
            break;
        }
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

// Lazily create the per-turn activity group (collapsed by default). It holds
// every MCP execution / output / query for a single turn behind one toggle.
function ensureActivityGroup(turnCtx) {
    if (turnCtx.group) return turnCtx.group;

    const container = document.getElementById('chatMessages');
    const group = document.createElement('div');
    group.className = 'activity-group collapsed';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'activity-group-header';
    header.innerHTML =
        '<span class="activity-chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></span>' +
        '<span class="activity-group-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></span>' +
        '<span class="activity-group-title">処理の詳細</span>' +
        '<span class="activity-group-count">0 ステップ</span>';

    const body = document.createElement('div');
    body.className = 'activity-group-body';

    header.addEventListener('click', () => group.classList.toggle('collapsed'));

    group.appendChild(header);
    group.appendChild(body);
    container.appendChild(group);

    group._body = body;
    group._count = 0;
    group._countEl = header.querySelector('.activity-group-count');

    turnCtx.group = group;
    return group;
}

// Append one collapsible step (tool call / result / query) into a group.
function appendActivityItem(group, opts) {
    const item = document.createElement('div');
    item.className = `activity-item ${opts.variant} collapsed`;

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'tool-label';

    const chevron = document.createElement('span');
    chevron.className = 'tool-chevron';
    chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

    const labelText = document.createElement('span');
    labelText.className = 'tool-label-text';
    labelText.textContent = opts.title;

    label.appendChild(chevron);
    label.appendChild(labelText);
    item.appendChild(label);

    if (opts.bodyText) {
        const body = document.createElement('div');
        body.className = 'tool-body';
        if (opts.codeLang) {
            const langTag = document.createElement('div');
            langTag.className = 'code-lang';
            langTag.textContent = opts.codeLang.toUpperCase();
            const pre = document.createElement('pre');
            pre.className = 'code-block';
            pre.textContent = opts.bodyText;
            body.appendChild(langTag);
            body.appendChild(pre);
        } else {
            body.textContent = opts.bodyText;
        }
        item.appendChild(body);
        label.addEventListener('click', () => item.classList.toggle('collapsed'));
    } else {
        label.classList.add('no-body');
    }

    group._body.appendChild(item);
    group._count++;
    group._countEl.textContent = `${group._count} ステップ`;
    scrollToBottom();
    return item;
}

// Keep the typing indicator visually below the activity group while streaming.
function keepTypingLast(turnCtx) {
    const el = turnCtx.typingEl;
    if (el && el.parentNode) {
        el.parentNode.appendChild(el);
        scrollToBottom();
    }
}

function appendMessage(type, content) {
    const container = document.getElementById('chatMessages');

    if (type === 'user' || type === 'assistant') {
        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper ${type}-wrapper`;

        const avatar = document.createElement('div');
        avatar.className = `message-avatar ${type}-avatar`;
        avatar.innerHTML = type === 'user'
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';

        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${type}`;
        msgDiv.textContent = content;

        wrapper.appendChild(avatar);
        wrapper.appendChild(msgDiv);
        container.appendChild(wrapper);
        scrollToBottom();
        return msgDiv;
    }

    const div = document.createElement('div');
    div.className = `message ${type}`;

    if (type === 'tool-call') {
        div.classList.add('collapsed');
        const lines = content.split('\n');

        const label = document.createElement('button');
        label.className = 'tool-label';
        label.type = 'button';

        const chevron = document.createElement('span');
        chevron.className = 'tool-chevron';
        chevron.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';

        const labelText = document.createElement('span');
        labelText.className = 'tool-label-text';
        labelText.textContent = lines[0];

        label.appendChild(chevron);
        label.appendChild(labelText);
        div.appendChild(label);

        if (lines.length > 1) {
            const body = document.createElement('div');
            body.className = 'tool-body';
            body.textContent = lines.slice(1).join('\n');
            div.appendChild(body);
            label.addEventListener('click', () => {
                div.classList.toggle('collapsed');
            });
        } else {
            label.classList.add('no-body');
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

    const chartDiv = document.createElement('div');
    chartDiv.className = 'vega-container';
    div.appendChild(chartDiv);
    container.appendChild(div);

    if (typeof vegaEmbed === 'undefined') {
        chartDiv.textContent = 'Vega-Lite ライブラリの読み込みに失敗しました';
        scrollToBottom();
        return div;
    }

    // For non-map charts, make them responsive to the container width.
    const embedSpec = Object.assign({}, spec);
    if (embedSpec.width !== undefined && !embedSpec.autosize) {
        embedSpec.width = 'container';
    }

    // For geographic maps, fit the projection to the actual data extent (e.g.
    // Japan only) instead of letting Vega-Lite fit to the whole world basemap.
    if (isMapSpec(embedSpec)) {
        fitProjectionToData(embedSpec);
    }

    vegaEmbed(chartDiv, embedSpec, {
        actions: false,
        mode: 'vega-lite',
        renderer: 'canvas',
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

// Fit a Vega-Lite geographic projection to the extent of the plotted data
// points. Flint emits a world basemap (world-110m) plus a bubble layer, and
// Vega-Lite's default projection fitting fits to the whole world - so data that
// only covers Japan renders as tiny dots on a global map. We compute the
// bounding box of the actual longitude/latitude data and set an explicit
// mercator center + scale so the map zooms to the data region.
function fitProjectionToData(spec) {
    const layers = Array.isArray(spec.layer) ? spec.layer : [spec];

    // 1. Find the longitude / latitude field names from any layer's encoding.
    let lonField = null;
    let latField = null;
    for (const l of layers) {
        const enc = l && l.encoding;
        if (!enc) continue;
        if (!lonField && enc.longitude && enc.longitude.field) lonField = enc.longitude.field;
        if (!latField && enc.latitude && enc.latitude.field) latField = enc.latitude.field;
    }

    // 2. Collect the data rows (top-level data, or any layer-level data).
    const rows = [];
    const pushRows = (d) => {
        if (d && Array.isArray(d.values)) rows.push(...d.values);
    };
    pushRows(spec.data);
    for (const l of layers) pushRows(l && l.data);

    // Without lon/lat fields or rows (e.g. choropleth by region id) we can't
    // compute an extent - fall back to stripping fixed projection params so
    // Vega-Lite at least auto-fits rather than using a hard-coded scale.
    if (!lonField || !latField || rows.length === 0) {
        stripProjectionParams(spec);
        return;
    }

    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    let count = 0;
    for (const row of rows) {
        const lon = Number(row[lonField]);
        const lat = Number(row[latField]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        if (lat <= -90 || lat >= 90) continue;
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
        count++;
    }
    if (count === 0) {
        stripProjectionParams(spec);
        return;
    }

    const width = Number(spec.width) || 600;
    const height = Number(spec.height) || 350;
    const DEG2RAD = Math.PI / 180;
    const mercY = (latDeg) => {
        const clamped = Math.max(-85, Math.min(85, latDeg));
        return Math.log(Math.tan(Math.PI / 4 + (clamped * DEG2RAD) / 2));
    };

    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;

    // Longitude / latitude spans with a sensible minimum so a single point (or
    // a very tight cluster) doesn't zoom in absurdly far.
    const MIN_SPAN_DEG = 4;
    const spanLon = Math.max(maxLon - minLon, MIN_SPAN_DEG) * DEG2RAD;
    const spanLat = Math.max(mercY(maxLat) - mercY(minLat), MIN_SPAN_DEG * DEG2RAD);

    // d3/mercator: projected extent in pixels = scale * (angular span). Fit both
    // axes and take the tighter one, then pad so points aren't flush to the edge.
    const PADDING = 1.35;
    const scaleLon = width / spanLon;
    const scaleLat = height / spanLat;
    let scale = Math.min(scaleLon, scaleLat) / PADDING;
    scale = Math.max(50, Math.min(scale, 20000));

    const projection = {
        type: 'mercator',
        center: [centerLon, centerLat],
        scale: scale,
    };
    for (const l of layers) {
        if (l && typeof l === 'object') l.projection = projection;
    }
    if (!Array.isArray(spec.layer)) spec.projection = projection;
}

// Strip explicit scale / center / translate from a Vega-Lite projection so the
// renderer auto-fits the map to the geographic data extent.
function stripProjectionParams(spec) {
    const strip = (proj) => {
        if (!proj || typeof proj !== 'object') return;
        delete proj.scale;
        delete proj.center;
        delete proj.translate;
    };
    strip(spec.projection);
    if (Array.isArray(spec.layer)) {
        spec.layer.forEach((l) => l && strip(l.projection));
    }
}

function appendTyping() {
    const container = document.getElementById('chatMessages');
    const wrapper = document.createElement('div');
    wrapper.className = 'typing-indicator';

    const avatar = document.createElement('div');
    avatar.className = 'typing-avatar';
    avatar.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2z"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';

    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';

    wrapper.appendChild(avatar);
    wrapper.appendChild(dots);
    container.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
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
        // Default new servers to Fabric Data Agent (streamable_http + Azure CLI auth)
        document.getElementById('mcpName').value = 'Fabric Data Agent';
        document.getElementById('mcpTransport').value = 'streamable_http';
        document.getElementById('mcpCommand').value = '';
        document.getElementById('mcpArgs').value = '';
        document.getElementById('mcpUrl').value = '';
        document.getElementById('mcpAuthType').value = 'azure_cli';
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
