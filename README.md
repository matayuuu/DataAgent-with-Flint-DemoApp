# Flint + Data Agent Playground

Azure Foundry Agent Service の Python SDK を使用した、**Flint Chart** と **Fabric Data Agent** による分析・可視化デモ用のローカル Web プレイグラウンドです。

MCP ツール (Flint Chart / Fabric Data Agent) の呼び出しと結果をチャット上で確認しながら、対話的にデータ分析・可視化を試せます。

## 機能

- **モデル選択**: Foundry プロジェクトで利用可能なモデルをプルダウンで選択
- **システムプロンプト**: エージェントの動作を定義するシステムプロンプトを設定
- **MCP サーバー管理**: MCP サーバーの追加・編集・削除
  - Flint Chart (プリセット済み・ローカル stdio): `npx -y flint-chart-mcp`
  - Fabric Data Agent (追加 MCP・Streamable HTTP): データエージェントへの質問と可視化
- **ターン単位のアクティビティ表示**: 1 ターンで発生した MCP 実行・出力を 1 つの折りたたみグループにまとめ、既定では非表示。展開すると各ステップを個別に開閉できます。

## 前提条件

- Python 3.11+
- Node.js 18+ (`npx` コマンドが必要 - Flint MCP 用)
- Azure CLI (`az login` で認証済み)
- Microsoft Foundry プロジェクト (デプロイ済みモデルあり)

## セットアップ

```bash
# 1. 仮想環境の作成
python -m venv .venv

# Windows
.venv\Scripts\activate

# 2. 依存関係のインストール
pip install -r requirements.txt

# 3. 環境変数の設定
copy .env.example .env
# .env ファイルを編集して PROJECT_ENDPOINT を設定

# 4. Azure CLI でログイン
az login

# 5. サーバー起動
python main.py
```

ブラウザで http://localhost:8000 を開きます。

## MCP サーバー

### Flint Chart (プリセット済み)

ローカルの stdio MCP サーバーとして設定済み:
- コマンド: `npx`
- 引数: `-y`, `flint-chart-mcp`

データの可視化やチャート生成をエージェントに依頼できます。

### Fabric Data Agent (追加 MCP サーバー)

追加 MCP サーバーは Fabric Data Agent を前提としています。UI の「＋ 追加」を押すと、既定値が Fabric Data Agent 向け (Streamable HTTP + Azure CLI 認証) に設定されます。

1. UI の「＋ 追加」をクリック
2. トランスポート: Streamable HTTP (リモート) ※既定
3. URL: Fabric Data Agent の MCP エンドポイント
   `https://api.fabric.microsoft.com/v1/mcp/workspaces/{WorkspaceId}/dataagents/{DataAgentId}/agent`
4. 認証: Azure CLI ※既定 (スコープ `https://api.fabric.microsoft.com/.default`)

`az login` 済みのトークンを使ってデータエージェントに接続します。

参考: https://learn.microsoft.com/ja-jp/fabric/data-science/data-agent-mcp-server

## アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│  Frontend (HTML/JS)                             │
│  - Chat UI                                      │
│  - Model/Prompt/MCP 設定パネル                   │
└────────────────────┬────────────────────────────┘
                     │ HTTP/SSE
┌────────────────────▼────────────────────────────┐
│  Backend (FastAPI)                              │
│  - /api/chat: エージェントループ                  │
│  - /api/models: モデル一覧                       │
│  - /api/mcp/*: MCP サーバー管理                  │
└────────┬───────────────────────┬────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐    ┌─────────────────────────┐
│ Azure Foundry   │    │ MCP Servers             │
│ (モデル推論)     │    │ - Flint (stdio/local)   │
│                 │    │ - Fabric Agent (HTTP)   │
└─────────────────┘    └─────────────────────────┘
```

エージェントループ:
1. ユーザーメッセージ → Foundry モデルに送信
2. モデルがツール呼び出しを返す → MCP サーバー経由で実行
3. ツール結果 → モデルに返送
4. 最終回答をユーザーに表示
