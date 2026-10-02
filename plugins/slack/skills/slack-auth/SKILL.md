---
name: slack-auth
description: "Slack OAuth token の取得・状態確認・削除を扱う。Triggers on: /slack-auth, /slack-auth login, /slack-auth status, /slack-auth clear, 'Slackにログイン', 'Slack認証状態を確認', 'Slackの保存トークンを削除'"
user-invocable: true
allowed-tools:
  - Bash
---

# slack-auth

Slack OAuth PKCE で読み取り専用 user token を取得し、OS secure store の保存状態確認と削除も行います。

## 手順

スクリプトをフルパスリテラルで実行する。変数展開は使わない。
スクリプトはこの SKILL.md の2つ上のディレクトリの `scripts/` にある。
例えばこの SKILL.md が `/a/b/skills/slack-auth/SKILL.md` なら、スクリプトは `/a/b/scripts/slack-auth.js`。

引数なしは login として扱います。

```bash
node /a/b/scripts/slack-auth.js
```

ログインを明示する場合:

```bash
node /a/b/scripts/slack-auth.js login
```

通常ログインで要求外の権限が返った場合は保存を拒否します。既存の保存済み token は残るため、読み取り専用への切り替え完了と説明しないでください。
Slack 側の既存認可の取り消し、または別の読み取り専用 App での再認証が必要です。`clear` だけでは権限は取り消されません。

状態確認:

```bash
node /a/b/scripts/slack-auth.js status
```

保存済み token record の削除:

```bash
node /a/b/scripts/slack-auth.js clear
```

`clear` は Slack 側の token revoke ではなく、OS secure store の保存 token record だけを削除します。

## sandbox 外での実行

このスクリプトは macOS Keychain または Windows Credential Manager に token record を保存・読み取り・削除します。
Claude Code / Codex の sandbox 内では OS secure store 操作に失敗するため、必ず最初から sandbox 外で実行してください。

### Claude Code の場合

Bash tool では `dangerouslyDisableSandbox: true` を指定し、理由として「Slack token を OS secure store で管理するため」と説明してください。
settings の `sandbox.excludedCommands` にこのスクリプトが登録されている環境では、通常の実行で sandbox 外になります（SETUP.md 参照）。

### Codex の場合

Codex の `exec_command` では `sandbox_permissions: "require_escalated"` を指定し、`justification` には「Slack token を OS secure store で管理するため」と書いてください。
可能なら `prefix_rule` に `["node", "/a/b/scripts/slack-auth.js"]` を指定してください。`/a/b/scripts/slack-auth.js` は実際に実行するフルパスに置き換えてください。

共有 Slack App の Client ID はスクリプトの既定値を使う。別 App を使う場合だけ `~/.config/scoped-connectors/slack/config.json` の `client_id`、または `SLACK_CLIENT_ID` で上書きする。
token 保存前に `auth.test` の `team_id` を allowlist と照合し、一致しない token は保存しない。
token record は macOS Keychain または Windows Credential Manager に保存します。file store と token 用環境変数は使いません。
Windows native と WSL では同じ Windows Credential Manager target `scoped-connectors/slack/default` を使います。

## 注意

token 値は出力しないでください。
`status` は保存済み token record を確認したうえで `auth.test` を呼び、token 値を表示せず、workspace、team_id、user、scope、有効期限だけを表示します。
認可に失敗した場合は、Slack App manifest の `pkce_enabled`、`redirect_urls`、`token_rotation_enabled`、Client ID、`allowed_team_ids` を確認してください。
