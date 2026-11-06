# Slack プラグイン セットアップ

## 1. プラグインのインストール

```sh
# Claude Code
claude plugin install slack@scoped-connectors

# Codex
# Codex セッション内で /plugins から slack をインストール
```

## 2. Slack OAuth PKCE でログイン

このプラグインのスキル `/slack-auth` または `/slack-auth login` を実行します。
`/slack-auth` は引数なしで login として動作します。
共有 Slack App の Client ID はプラグインに同梱されています。

スクリプトを直接実行する場合:

```sh
node plugins/slack/scripts/slack-auth.js
# または
node plugins/slack/scripts/slack-auth.js login
```

表示された URL をブラウザで開き、Slack の読み取り権限を許可してください。

認証方式と token 保存の仕様は [README](README.md#参考-認証と-token-保存) を参照してください。

## 3. コマンド実行許可の設定

このプラグインは token の保存・読み取りに OS secure store を使います。
Claude Code / Codex では OS secure store の保存・読み取りが sandbox 内で失敗します。
このプラグインの Slack 系 skill は sandbox 外でスクリプトを実行する前提です。
初回実行時に sandbox 外実行の承認を求められたら許可してください。

Windows native と WSL では同じ Windows Credential Manager target `scoped-connectors/slack/default` を使います。
WSL では `wslpath` と `powershell.exe` が必要です。

### Claude Code の場合

Keychain / Credential Manager を使う Slack 系コマンドは sandbox 外実行が必要です。
一時的に実行するだけなら Bash tool の `dangerouslyDisableSandbox` でも回避できます。
継続利用で承認を省略したい場合だけ、プロジェクトまたはユーザーの設定ファイルに次の2つを設定してください。

- `sandbox.excludedCommands`: 登録したコマンドは常に sandbox 外で実行されます。sandbox 内で一度失敗してから再試行する無駄がなくなります。
- `permissions.allow`: sandbox 外実行も通常の permission フローを通るため、`Bash(...)` ルールを併せて設定すると承認プロンプトを省略できます。

どちらのパターンも、このプラグインの実際のインストールパスを自分で確認して絶対パスで書いてください。
インストールパスは `~/.claude/plugins/installed_plugins.json` の `installPath` で確認できます。バージョンのディレクトリ部分だけ `*` にします。
`*/plugins/slack/scripts/*` のような前方ワイルドカードは、同名のディレクトリ構造を持つ任意のリポジトリのスクリプトまで sandbox 外・承認なしで実行できてしまうため使わないでください。

### Codex の場合

Keychain / Credential Manager を使う Slack 系コマンドは sandbox 外実行が必要です。
各 `SKILL.md` は `sandbox_permissions: "require_escalated"` と script ごとの `prefix_rule` を使うように記載しています。

初回承認時に prefix rule を保存すると、同じ script の次回以降の実行で承認を省略しやすくなります。
対象 script は `slack-auth.js`、`channels.js`、`users.js`、`history.js`、`thread.js`、`search.js`、`reactions.js` です。

## 参考: 実 Slack smoke

OAuth、OS secure store 保存、実 Slack API の最小確認には `smoke.js` を使います。
この script も Keychain / Credential Manager を読むため sandbox 外で実行してください。

```sh
node plugins/slack/scripts/smoke.js --channel general --query test
```

token が未保存の場合は、先に `/slack-auth` または次のコマンドでログインします。

```sh
node plugins/slack/scripts/slack-auth.js
```

`smoke.js --login` を指定すると、token 未保存時に同じ login flow を開始します。
Slack の許可画面はブラウザで手動承認してください。

既定では Slack メッセージ本文は表示せず、件数とメタデータだけを表示します。
本文も短く確認したい場合だけ `--show-text` を指定します。Slack token らしい文字列は出力時に伏せます。

## 参考: プラグインの更新

### Claude Code

```sh
claude plugin update slack@scoped-connectors
```

更新後は Claude Code を再起動してください。

### Codex

Codex は marketplace snapshot を更新してから、プラグインを入れ直します。

```sh
codex plugin marketplace upgrade scoped-connectors
codex plugin remove slack@scoped-connectors
codex plugin add slack@scoped-connectors
```

更新後は Codex セッションを再起動してください。

## 参考: アンインストール

プラグインのアンインストールは、ローカルの Claude Code / Codex からこのプラグインを外す操作です。
Slack App や発行済み OAuth Token の削除とは別です。

```sh
# Claude Code
claude plugin uninstall slack@scoped-connectors

# Codex
# Codex セッション内で /plugins からプラグインをアンインストール
```

## 参考: 別 Slack App / allowlist の上書き

別 Slack App を使う場合だけ、`~/.config/scoped-connectors/slack/config.json` で上書きします。
Client ID と team ID は公開識別子であり、client secret ではありません。

```json
{
  "client_id": "123.456",
  "redirect_uri": "http://localhost:53682/slack/oauth/callback",
  "allowed_team_ids": ["T12345678"]
}
```

環境変数 `SLACK_CLIENT_ID`、`SLACK_ALLOWED_TEAM_IDS` でも指定できます。
`SLACK_ALLOWED_TEAM_IDS` はカンマ区切りです。
guest user（`users.info` の `is_restricted` / `is_ultra_restricted` が true のユーザー）の token は常に保存を拒否します。この判定は設定では変更できません。

既存 App に scope を追加した場合、管理側で承認済みになった後も、必ず「Install App」ページから再インストールしてください。
再インストールしないと、Slack API の `provided` scope に新しい権限が反映されないことがあります。

## 参考: リアクション操作を有効にする

1. Slack App の管理者が manifest の `oauth_config.scopes.user` に `reactions:read` と `reactions:write` を宣言し、同じ scope を `user_optional` にも追加して任意の権限にします。Slack の仕様上、任意 scope も `user` への宣言が必要です。通常ログインで要求する scope は増やしません。
2. ワークスペースの承認が必要な場合は承認後、「Install App」から再インストールします。リポジトリへのマージだけでは実際の Slack App の設定は変わりません。
3. 利用者が次のコマンドで再認証し、ブラウザの許可画面で権限を確認します。

   ```sh
   node plugins/slack/scripts/slack-auth.js login --reactions
   node plugins/slack/scripts/slack-auth.js status
   ```

`status` の `scope` に `reactions:read` と `reactions:write` が含まれることを確認してください。
既に投稿権限も使っている場合は `login --write --reactions` で、引き続き必要な権限を明示してください。
通常の `login` / `login --write` ではリアクション権限を要求しません。
要求していない権限が Slack 側の既存認可に残っていた場合は Token Record の保存を拒否し、既存の保存済み Token Record を維持します。
読み取り専用へ戻すには Slack 側の認可を取り消して再認証するか、別 App を使ってください。`clear` は Slack 側の権限を取り消しません。

権限は public / private / DM を区別しません。コネクタ側の制限とレビュー時の使い方は [README](README.md#権限と対象範囲) を参照してください。
