# Cloudflare Workers 開発ガイド

## 1. 概要
Cloudflare Workersは、エッジロケーション（CloudflareのCDN拠点）でJavaScript/TypeScriptを実行できるサーバーレスプラットフォームです。
高速な起動、低遅延、そして強力な無料枠が特徴です。

## 2. 開発環境のセットアップ

### 必須ツール
*   **Node.js**: LTS版推奨
*   **Wrangler (CLI)**: Cloudflare Workersの開発・デプロイツール
    ```bash
    npm install -D wrangler
    ```

### プロジェクト作成
```bash
npm create cloudflare@latest my-project
```
対話形式でテンプレート（Hello World等）やTypeScriptの使用有無を選択できます。

### ツール・依存関係の更新
開発中に `update available` という通知が表示された場合や、最新機能・修正を利用したい場合に実行します。

*   **プロジェクト内のWranglerを更新 (推奨)**:
    ```bash
    npm install --save-dev wrangler@latest
    ```
*   **PC全体（グローバル）のWranglerを更新**:
    ```bash
    npm install -g wrangler@latest
    ```
*   **プロジェクト全体の依存関係を更新**:
    ```bash
    npm update
    ```

> **Tip**: プロジェクトごとにバージョンの不整合を防ぐため、基本的にはプロジェクト内（Local）にインストールされたWranglerを使用し、`npx wrangler` または `npm start` で起動することが推奨されます。

## 3. 主なコマンド (Wrangler)

| コマンド | 説明 |
| :--- | :--- |
| `wrangler dev` | ローカル開発サーバーを起動 (ホットリロード対応) |
| `wrangler deploy` | Cloudflare上へデプロイ (本番公開) |
| `wrangler login` | Cloudflareアカウントへのログイン (初回のみ) |
| `wrangler tail` | 本番環境のリアルタイムログを確認 |
| `wrangler kv:namespace create` | KV(Key-Valueストア)の名前空間を作成 |
| `wrangler secret put <KEY>` | 環境変数（APIキーなど）を安全に設定 |

## 4. `wrangler.toml` 設定ファイル
プロジェクトの構成ファイルです。

```toml
name = "my-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# 静的ファイルの配信設定（オプション）
[assets]
directory = "./public"
binding = "ASSETS"

# KV設定（オプション）
[[kv_namespaces]]
binding = "MY_KV"
id = "xxxxxxxxxxxxxxxxxxxxxxxx"
```

## 5. コーディング (TypeScriptの例)

`src/index.ts` の基本構造:

```typescript
export interface Env {
    // wrangler.tomlでバインディングしたリソースの型定義
    MY_KV: KVNamespace;
    ASSETS: Fetcher;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // ルーティング例
        const url = new URL(request.url);

        if (url.pathname === "/api/hello") {
            return new Response("Hello Cloudflare!");
        }

        // 静的アセットの配信（設定している場合）
        return env.ASSETS.fetch(request);
    },
};
```

## 6. 主要な周辺機能

### KV (Key-Value Storage)
低遅延なキーバリューストア。設定情報の保存やキャッシュに最適。
*   読み込み: `await env.MY_KV.get("key")`
*   書き込み: `await env.MY_KV.put("key", "value")`

### Durable Objects
強力な整合性を持つステートフルなオブジェクト。チャットやゲームなどリアルタイム性が求められる用途に。

### R2
S3互換のオブジェクトストレージ。画像の保存などに使用。

### D1
SQLiteベースのサーバーレスSQLデータベース。

## 7. トラブルシューティングのヒント
*   **ローカルと本番の差異**: KVやD1などのリソースIDは、ローカル環境（`wrangler dev`）と本番環境で異なる場合があります。プレビュー用IDの設定が必要なことがあります。
*   **パッケージサイズ**: Workersにはスクリプトサイズの制限（無料プランで1MB、有料で10MBなど）があります。
*   **Compatilibity Date**: Cloudflareのランタイム更新による挙動変更を管理するために、`wrangler.toml` の `compatibility_date` は定期的に最新にするのが推奨されます。
