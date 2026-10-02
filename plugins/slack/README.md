# Slack プラグイン

Slack のメッセージを取得・検索するプラグインです。
コマンドや自然言語（「generalの最近のメッセージ見せて」など）で、チャンネルの投稿内容やスレッドを確認できます。

提供する操作は読み取り専用です。メッセージの送信・編集・削除機能はありません。

**[セットアップ手順](SETUP.md)**

## 使い方

### Claude Code

| コマンド | 説明 |
|---|---|
| `/slack-auth` | Slack OAuth PKCE でログイン（引数なしは login） |
| `/slack-auth login` | Slack OAuth PKCE でログイン（明示形） |
| `/slack-auth status` | 保存済み Slack token record と `auth.test` live 状態の確認（token 値は非表示） |
| `/slack-auth clear` | OS secure store の保存済み Slack token record を削除 |
| `/slack-channels` | チャンネル一覧を表示 |
| `/slack-users` | ユーザー・グループキャッシュを更新 |
| `/slack-history <channel> [limit]` | 指定チャンネルのメッセージを取得 |
| `/slack-history <channel> [limit] 先週` | 期間指定でメッセージを取得 |
| `/slack-thread <channel> <timestamp>` | スレッドのメッセージを取得（ts指定） |
| `/slack-thread <URL>` | スレッドのメッセージを取得（URL指定、チャンネル不要） |
| `/slack-search <keyword> [count]` | パブリックチャンネルの投稿を検索（デフォルト3件、最大100件） |
| `/slack-search <keyword> [count] 先週` | 期間指定でパブリックチャンネルの投稿を検索 |

`timestamp` は Slack がメッセージを一意に識別するための値です（例: `1776320535.121069`）。
メッセージ取得の出力に含まれるので、そこからコピーしてスレッド取得に使えます。
Slack のメッセージURLでも指定できます。

自然言語でも利用できます。

```
generalの最近のメッセージ見せて
```

### Codex

`$slack` でプラグインを呼び出し、自然言語で指示します。

```
$slack generalの最近のメッセージを5件見せて
```

## 参考: 認証と token 保存

Slack App manifest では PKCE と token rotation を有効にしています。
このプラグインは PKCE 前提のため `client_secret` は設定・送信しません。

token record は macOS Keychain または Windows Credential Manager に保存します。
Windows native と WSL では同じ Windows Credential Manager target `scoped-connectors/slack/default` を使います。
file store と token 用環境変数は使いません。

token 保存前に `auth.test` の `team_id` を allowlist と照合し、一致しない token は保存しません。
既定の allowlist は対象 workspace の team ID `T06B7BCTU` です。
guest user（`is_restricted` / `is_ultra_restricted`）の token は常に保存しません。

保存状態と Slack API 上の live 状態は `/slack-auth status`、保存済み token record の削除は `/slack-auth clear` で確認・実行できます。
スクリプトを直接実行する場合は `node plugins/slack/scripts/slack-auth.js status` と `node plugins/slack/scripts/slack-auth.js clear` を使います。
`clear` は Slack 側の token revoke ではなく、ローカルの OS secure store から保存 token record を削除します。

## 参考: 共有 Slack App

このプラグインは共有 Slack App の Client ID を同梱しています。
通常の利用者は Slack App を作成しません。

共有 Slack App は Public Distribution を有効化せず、対象 workspace 用の App として管理します。

通常ログインは以下の読み取り専用スコープだけを要求します:

| スコープ | 用途 |
|---|---|
| `channels:read` | パブリックチャンネルの一覧取得 |
| `channels:history` | チャンネルのメッセージ履歴取得 |
| `search:read.public` | Real-time Search API でのパブリックチャンネル検索 |
| `users:read` | ユーザー名の表示 |
| `usergroups:read` | ユーザーグループ名の表示 |

このプラグインの検索は `search:read.public` scope の Real-time Search API で実装しています。
認可ユーザーが閲覧できるプライベートチャンネルの結果を返す可能性があるため、`search:read` は付与しません。
