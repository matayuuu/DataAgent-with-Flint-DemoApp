# Flint + Data Agent Playground

**Fabric Data Agent** でデータを分析し、**Flint Chart** で可視化する流れを試せる、ローカル Web チャットプレイグラウンドです。Azure Foundry Agent Service（Python SDK）をバックエンドに、MCP ツールの呼び出しと結果をチャット上で確認しながら対話的に操作できます。

## 主な機能

- **チャット UI**: モデルとシステムプロンプトを選んで対話
- **MCP サーバー管理**: サーバーの追加・編集・削除（UI から）
  - Flint Chart … チャート生成（プリセット済み）
  - Fabric Data Agent … データエージェントへの質問（追加して利用）
- **アクティビティ表示**: 1 ターンの MCP 実行・出力を折りたたみでまとめて表示

## 必要なもの

- Python 3.11+
- Node.js 18+（Flint MCP の `npx` 用）
- Azure CLI（`az login` 済み）
- Microsoft Foundry プロジェクト（モデルをデプロイ済み）

## クイックスタート

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows

pip install -r requirements.txt

copy .env.example .env        # .env の PROJECT_ENDPOINT を設定

az login
python main.py
```

起動後、ブラウザで http://localhost:8000 を開きます。

## Fabric Data Agent を追加する

UI の「＋ 追加」を押すと、既定値が Fabric Data Agent 向け（Streamable HTTP + Azure CLI 認証）で入力されます。URL だけ自分のエンドポイントに置き換えてください。

```
https://api.fabric.microsoft.com/v1/mcp/workspaces/{WorkspaceId}/dataagents/{DataAgentId}/agent
```

`az login` のトークン（スコープ `https://api.fabric.microsoft.com/.default`）で接続します。
詳細: https://learn.microsoft.com/ja-jp/fabric/data-science/data-agent-mcp-server

## 仕組み

```
ブラウザ (Chat UI)
      │  HTTP / SSE
FastAPI バックエンド  ──►  Azure Foundry（モデル推論）
      │
      └─►  MCP サーバー（Flint Chart / Fabric Data Agent）
```

1. ユーザーの質問をモデルに送信
2. モデルが MCP ツールを呼び出し、バックエンドが実行
3. 結果をモデルに返し、最終回答とチャートを表示

## ライセンス

[Apache License 2.0](LICENSE)（商用利用可）
