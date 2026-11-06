---
name: slack-reactions
description: "Slack の投稿に付いた絵文字リアクションの確認・追加・自分のリアクションの削除。スタンプの操作やレビュー着手・完了の共有を依頼されたときに使用する。"
allowed-tools:
  - Bash
---

# slack-reactions

パブリックチャンネルの投稿のリアクションを確認・追加・削除します。
変更できるのは参加済み・未アーカイブのチャンネルのみです。
認証ユーザー自身のリアクションを操作します。他人のスタンプは外せません。

## 実行

この SKILL.md の2つ上のディレクトリの `scripts/reactions.js` を、フルパスリテラルで実行します。
例えばこのファイルが `/a/b/skills/slack-reactions/SKILL.md` なら、スクリプトは `/a/b/scripts/reactions.js` です。

```sh
node /a/b/scripts/reactions.js get '<Slack メッセージURL>'
node /a/b/scripts/reactions.js add '<Slack メッセージURL>' in_review
node /a/b/scripts/reactions.js remove '<Slack メッセージURL>' in_review
```

URL の代わりに `<channel ID> <timestamp>` も指定できます。
スレッド内の投稿を対象にする場合、親投稿の `thread_ts` ではなく対象投稿の timestamp を指定します。

変更は、ユーザーから対象投稿・絵文字・追加または削除の指示がある場合に実行します。
レビュー開始時の付与と完了時の削除をまとめて依頼された場合、その許可は同じレビュー作業に適用できます。
対象・絵文字が不明なら先に確認してください。

認証には `slack-auth login --reactions` が必要です。
権限不足の場合は App 管理者による scope 追加・再インストールと利用者による再認証が必要です。
自動で権限を広げたりログインしたりせず、セットアップ手順を案内してください。

## レビュー担当の共有

1. 対象の依頼投稿を `get` で確認します。`in_review` の `count` が正なら、既存の担当を確認してから進めます。
2. 未着手でレビューを任された場合、`add` で `in_review` を付け、結果を確認します。
3. 追加後にも `get` し、他のメンバーと重複していないか確認します。複数のスタンプがあれば担当を調整するまでレビューを保留します。
4. 完了時には、この作業で自分が付けた、または自分の担当だと確認できたスタンプだけを外します。

`users` は全員を含むとは限らないため、スタンプの有無は `count` で判断してください。
`already_reacted` は新しく付与したことを意味しません。同じ Slack ユーザーの複数エージェントも区別できないため、担当取得と扱わないでください。
確認と追加は一体の操作ではなく、完全な排他制御にはなりません。
API エラーや通信断で結果が不明なら、`get` で状態を確認してから判断し、無条件の再試行やレビュー着手は避けてください。

## 実行環境と出力

OS secure store を読み取るため、既存の Slack スキルと同様に最初から sandbox 外で実行します。
Claude Code は `dangerouslyDisableSandbox: true`、Codex は `sandbox_permissions: "require_escalated"` とこのスクリプト固有の `prefix_rule` を使います。
現在のセッションの実行権限に関する上位指示がある場合はそちらを優先します。

結果のチャンネル ID・timestamp・絵文字・status を伝えてください。`get` はリアクション情報のみを返します。
Token Record や token 値は出力しません。
