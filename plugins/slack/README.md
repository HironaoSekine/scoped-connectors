# Slack プラグイン

Slack のメッセージを取得・検索するプラグインです。
コマンドや自然言語（「generalの最近のメッセージ見せて」など）で、チャンネルの投稿内容やスレッドを確認できます。

通常は読み取り専用です。`--reactions` 付きでログインすると、パブリックチャンネルの投稿に付いたリアクションの確認・追加・自分のリアクションの削除も行えます。
メッセージの送信・編集・削除機能はありません。

**[セットアップ手順](SETUP.md)**

## 使い方

### Claude Code

| コマンド | 説明 |
|---|---|
| `/slack-auth` | Slack OAuth PKCE でログイン（引数なしは login） |
| `/slack-auth login` | Slack OAuth PKCE でログイン（明示形） |
| `/slack-auth login --reactions` | リアクションの確認・追加・削除を有効化してログイン |
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
| `/slack-reactions get <URL>` | 対象投稿のリアクションを確認 |
| `/slack-reactions add <URL> <emoji>` | 対象投稿に自分のリアクションを追加 |
| `/slack-reactions remove <URL> <emoji>` | 対象投稿から自分のリアクションを削除 |

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

## リアクションによるレビュー着手・完了の共有

`--reactions` は `reactions:read` と `reactions:write` を要求します。
`--write`（`chat:write`）とは独立しており、メッセージ投稿権限は不要です。
利用を始める前の設定・再認証は [セットアップ](SETUP.md#参考-リアクション操作を有効にする) を参照してください。

```sh
# 1. 対象投稿に :in_review: が付いているか確認
node plugins/slack/scripts/reactions.js get 'https://example.slack.com/archives/C123/p1786603301830739'

# 2. 未着手なら自分の :in_review: を追加
node plugins/slack/scripts/reactions.js add 'https://example.slack.com/archives/C123/p1786603301830739' in_review

# 3. レビュー完了後、自分の :in_review: を外す
node plugins/slack/scripts/reactions.js remove 'https://example.slack.com/archives/C123/p1786603301830739' in_review
```

URL の代わりに `<channel ID> <timestamp>` も指定できます。
スレッド内の投稿URLは、その投稿自体を対象にします（クエリの `thread_ts` は使いません）。
絵文字は `in_review` / `:in_review:` のどちらでも指定できます。
User token で操作するため、手動で付けた自分のリアクションも削除できます。他人のリアクションは削除できません。

`get` は `name`・`count`・`users` を JSON で返し、本文は出力しません。
Slack の `users` 配列は全員を含むとは限らないため、着手済みかは `count` で判断してください。
`add` の `already_reacted` と `remove` の `no_reaction` は「変更なし」として返し、新たな付与・削除と区別します。
同じ Slack ユーザーを使う複数のエージェントは区別できません。`already_reacted` はレビュー担当を取得できた証拠にはなりません。

**リアクションは排他ロックではありません。** 確認と追加の間に別メンバーが着手する可能性があります。
追加後にも再取得し、`in_review` の `count` が複数なら着手を保留して担当を調整してください。
追加に成功したか不明な場合は再取得し、無条件に再実行したりレビューを始めたりしないでください。
完了時も、この作業で自分が付けた、または自分の担当と確認できたスタンプだけを外してください。

### 権限と対象範囲

`reactions:read` / `reactions:write` は Slack 側では public 専用の scope ではありません。
特に `reactions.get` は関連する本文も返せるため、権限を付けると Token Record の認証ユーザーが閲覧できる private / DM にもアクセスし得ます。
**通常ログインには追加せず、利用者が `--reactions` で選んだ場合だけ要求します。**

コネクタ側は、リアクションAPIを呼ぶ前に `conversations.info` で public と確認できたチャンネルのみ許可します。
追加・削除には参加済み・未アーカイブであることも必要です。判定に必要な情報が欠けている場合は操作しません。
private / DM、ファイルへのリアクション、ユーザー横断の `reactions.list` は提供しません。
この制限はスクリプト側のものです。Token Record の権限自体を public に限定するものではありません。

公式仕様: [reactions.get](https://docs.slack.dev/reference/methods/reactions.get/)・[reactions.add](https://docs.slack.dev/reference/methods/reactions.add/)・[reactions.remove](https://docs.slack.dev/reference/methods/reactions.remove/)
