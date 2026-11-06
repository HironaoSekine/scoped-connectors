const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  AUTH_URI,
  TOKEN_URI,
  SLACK_API_URI,
  DEFAULT_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
  DEFAULT_ALLOWED_TEAM_IDS,
  DEFAULT_CONFIG_PATH,
  READONLY_SCOPES,
  OPTIONAL_SCOPES,
  requestedScopes,
  normalizeTeamIds,
  applyDefaults,
  parseArgs,
  validateOptions,
  extractGrantedScopes,
  getMissingRequiredScopes,
  validateGrantedScopes,
  base64Url,
  createPkcePair,
  buildAuthorizeUrl,
  validateAuthorizationCallback,
  exchangeCodeForToken,
  fetchSlackApiWithToken,
  verifyTokenAuthorization,
  buildTokenRecord,
} = require("../oauth-login");

describe("parseArgs", () => {
  it("既定の共有 Client ID と allowed team ids を解析する", () => {
    assert.deepEqual(parseArgs([], {}, () => ({})), {
      configPath: DEFAULT_CONFIG_PATH,
      clientId: DEFAULT_CLIENT_ID,
      redirectUri: DEFAULT_REDIRECT_URI,
      allowedTeamIds: DEFAULT_ALLOWED_TEAM_IDS,
      help: false,
      write: false,
      reactions: false,
    });
  });

  it("環境変数の client id を解析する", () => {
    assert.deepEqual(
      parseArgs([], { SLACK_CLIENT_ID: "123.456", SLACK_ALLOWED_TEAM_IDS: "T123,T456" }, () => ({})),
      {
      configPath: DEFAULT_CONFIG_PATH,
      clientId: "123.456",
      redirectUri: DEFAULT_REDIRECT_URI,
        allowedTeamIds: ["T123", "T456"],
      help: false,
      write: false,
      reactions: false,
      }
    );
  });

  it("token 保存先オプションは受け付けない", () => {
    assert.throws(
      () => parseArgs(["--token-path", "/tmp/slack-token.json"], {}, () => ({ allowed_team_ids: ["T123"] })),
      /不明なオプション/
    );
    assert.throws(
      () => parseArgs(["--store", "file"], {}, () => ({ allowed_team_ids: ["T123"] })),
      /不明なオプション/
    );
  });

  it("client id がなければ検証で失敗する", () => {
    assert.throws(
      () => validateOptions({ clientId: "", redirectUri: DEFAULT_REDIRECT_URI }),
      /Client ID/
    );
  });

  it("allowed team ids がなければ検証で失敗する", () => {
    assert.throws(
      () => validateOptions({ clientId: "123.456", redirectUri: DEFAULT_REDIRECT_URI, allowedTeamIds: [] }),
      /allowed_team_ids/
    );
  });

  it("https redirect URI は拒否する", () => {
    assert.throws(
      () =>
        validateOptions({
          clientId: "123.456",
          redirectUri: "https://localhost:53682/slack/oauth/callback",
          allowedTeamIds: ["T123"],
        }),
      /http/
    );
  });
});

describe("applyDefaults", () => {
  it("CLI 引数が config と env より優先される", () => {
    const options = applyDefaults(
      {
        configPath: "/tmp/config.json",
        clientId: "cli",
        redirectUri: "http://localhost:53682/slack/oauth/callback",
        allowedTeamIds: ["TCLI"],
        help: false,
        write: false,
        reactions: false,
      },
      {
        client_id: "config",
        redirect_uri: "http://localhost:1111/slack/oauth/callback",
        allowed_team_ids: ["TCONFIG"],
      },
      {
        SLACK_CLIENT_ID: "env",
        SLACK_REDIRECT_URI: "http://localhost:2222/slack/oauth/callback",
        SLACK_ALLOWED_TEAM_IDS: "TENV",
      }
    );

    assert.equal(options.clientId, "cli");
    assert.equal(options.redirectUri, "http://localhost:53682/slack/oauth/callback");
    assert.deepEqual(options.allowedTeamIds, ["TCLI"]);
  });
});

describe("normalizeTeamIds", () => {
  it("配列とカンマ区切り文字列を team id 配列へ正規化する", () => {
    assert.deepEqual(normalizeTeamIds(["T123", " T456 "]), ["T123", "T456"]);
    assert.deepEqual(normalizeTeamIds("T123, T456"), ["T123", "T456"]);
  });
});

describe("scope validation", () => {
  it("top-level scope と authed_user.scope を正規化する", () => {
    assert.deepEqual(
      Array.from(extractGrantedScopes({ scope: "channels:read users:read,search:read.public" })).sort(),
      ["channels:read", "search:read.public", "users:read"]
    );
    assert.deepEqual(
      Array.from(extractGrantedScopes({ authed_user: { scope: ["channels:read", "users:read"] } })).sort(),
      ["channels:read", "users:read"]
    );
  });

  it("必要な scope が揃っていれば不足なしにする", () => {
    assert.deepEqual(
      getMissingRequiredScopes(extractGrantedScopes({ authed_user: { scope: READONLY_SCOPES.join(",") } })),
      []
    );
    assert.doesNotThrow(() =>
      validateGrantedScopes({ scope: READONLY_SCOPES.join(",") })
    );
  });

  it("不足 scope があれば token を保存する前に失敗し、token 値を出さない", () => {
    const tokenResponse = {
      access_token: "xoxe.xoxp-secret",
      refresh_token: "xoxe-refresh-secret",
      scope: "channels:read,users:read",
    };

    assert.deepEqual(
      getMissingRequiredScopes(extractGrantedScopes(tokenResponse)),
      ["channels:history", "search:read.public", "usergroups:read"]
    );
    assert.throws(
      () => validateGrantedScopes(tokenResponse),
      (err) => {
        assert.match(err.message, /scope が不足/);
        assert.match(err.message, /channels:history/);
        assert.match(err.message, /search:read\.public/);
        assert.doesNotMatch(err.message, /xoxe\.xoxp-secret/);
        assert.doesNotMatch(err.message, /xoxe-refresh-secret/);
        return true;
      }
    );
  });

  it("scope が response に含まれなければ再インストールと再ログインを促す", () => {
    assert.throws(
      () => validateGrantedScopes({ access_token: "xoxe.xoxp-secret" }),
      (err) => {
        assert.match(err.message, /scope が含まれていません/);
        assert.match(err.message, /再ログイン/);
        assert.doesNotMatch(err.message, /xoxe\.xoxp-secret/);
        return true;
      }
    );
  });
});

describe("PKCE", () => {
  it("base64url に変換する", () => {
    assert.equal(base64Url(Buffer.from([251, 255, 191])), "-_-_");
  });

  it("verifier と S256 challenge を生成する", () => {
    const pair = createPkcePair();
    assert.match(pair.verifier, /^[A-Za-z0-9_-]+$/);
    assert.match(pair.challenge, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(pair.verifier, pair.challenge);
  });
});

describe("buildAuthorizeUrl", () => {
  it("Slack user OAuth PKCE URL は既定で読み取り権限のみを要求する", () => {
    const url = buildAuthorizeUrl(
      { clientId: "123.456", redirectUri: DEFAULT_REDIRECT_URI },
      { challenge: "challenge" },
      "state"
    );

    assert.equal(url.origin + url.pathname, AUTH_URI);
    assert.equal(url.searchParams.get("client_id"), "123.456");
    assert.equal(url.searchParams.get("redirect_uri"), DEFAULT_REDIRECT_URI);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.deepEqual(OPTIONAL_SCOPES, ["chat:write"]);
    assert.equal(url.searchParams.get("scope"), READONLY_SCOPES.join(","));
    assert.doesNotMatch(url.searchParams.get("scope"), /(?:^|,)chat:write(?:,|$)/);
    assert.equal(url.searchParams.get("code_challenge"), "challenge");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("state"), "state");
  });
});

describe("validateAuthorizationCallback", () => {
  it("code と state が一致すれば code を返す", () => {
    assert.equal(
      validateAuthorizationCallback({
        code: "code",
        returnedState: "expected-state",
        expectedState: "expected-state",
      }),
      "code"
    );
  });

  it("Slack error callback は拒否する", () => {
    assert.throws(
      () =>
        validateAuthorizationCallback({
          error: "access_denied",
          code: "code",
          returnedState: "expected-state",
          expectedState: "expected-state",
        }),
      (err) => {
        assert.match(err.message, /access_denied/);
        assert.equal(err.responseBody, "Slack authorization failed. You can close this tab.");
        return true;
      }
    );
  });

  it("code がなければ拒否する", () => {
    assert.throws(
      () =>
        validateAuthorizationCallback({
          returnedState: "expected-state",
          expectedState: "expected-state",
        }),
      (err) => {
        assert.match(err.message, /認可レスポンスが不正/);
        assert.equal(err.responseBody, "Invalid authorization response. You can close this tab.");
        return true;
      }
    );
  });

  it("state が一致しなければ拒否する", () => {
    assert.throws(
      () =>
        validateAuthorizationCallback({
          code: "code",
          returnedState: "attacker-state",
          expectedState: "expected-state",
        }),
      (err) => {
        assert.match(err.message, /認可レスポンスが不正/);
        assert.equal(err.responseBody, "Invalid authorization response. You can close this tab.");
        return true;
      }
    );
  });
});

describe("exchangeCodeForToken", () => {
  it("client_secret を送らず code_verifier で token を取得する", async () => {
    let captured;
    const data = await exchangeCodeForToken(
      { clientId: "123.456" },
      {
        code: "code",
        codeVerifier: "verifier",
        redirectUri: DEFAULT_REDIRECT_URI,
      },
      async (url, options) => {
        captured = { url, options, body: options.body.toString() };
        return {
          ok: true,
          async json() {
            return {
              ok: true,
              access_token: "xoxe.xoxp-1-token",
              refresh_token: "xoxe-1-refresh",
              expires_in: 43200,
              token_type: "user",
              team: { id: "T123", name: "Example" },
              authed_user: { id: "U123", scope: READONLY_SCOPES.join(",") },
            };
          },
        };
      }
    );

    assert.equal(captured.url, TOKEN_URI);
    assert.equal(captured.options.method, "POST");
    assert.match(captured.body, /client_id=123\.456/);
    assert.match(captured.body, /code=code/);
    assert.match(captured.body, /code_verifier=verifier/);
    assert.match(captured.body, /grant_type=authorization_code/);
    assert.doesNotMatch(captured.body, /client_secret/);
    assert.equal(data.refresh_token, "xoxe-1-refresh");
  });

  it("refresh token がない場合は設定不足として失敗する", async () => {
    await assert.rejects(
      () =>
        exchangeCodeForToken(
          { clientId: "123.456" },
          { code: "code", codeVerifier: "verifier", redirectUri: DEFAULT_REDIRECT_URI },
          async () => ({
            ok: true,
            async json() {
              return { ok: true, access_token: "xoxp-token" };
            },
          })
        ),
      /refresh_token/
    );
  });
});

describe("fetchSlackApiWithToken", () => {
  it("Bearer token で Slack API を呼ぶ", async () => {
    let captured;
    const data = await fetchSlackApiWithToken("auth.test", "xoxp-test", {}, async (url, options) => {
      captured = { url: url.toString(), options };
      return {
        ok: true,
        async json() {
          return { ok: true, team_id: "T123" };
        },
      };
    });

    assert.equal(captured.url, `${SLACK_API_URI}auth.test`);
    assert.equal(captured.options.method, "POST");
    assert.equal(captured.options.headers.Authorization, "Bearer xoxp-test");
    assert.equal(data.team_id, "T123");
  });
});

describe("verifyTokenAuthorization", () => {
  it("allowed team id と一致し guest でなければ認証情報を返す", async () => {
    const calls = [];
    const responses = [
      { ok: true, team_id: "T123", team: "Example", user_id: "U123" },
      { ok: true, user: { id: "U123", is_restricted: false, is_ultra_restricted: false } },
    ];
    const result = await verifyTokenAuthorization(
      { allowedTeamIds: ["T123"] },
      { access_token: "xoxp-test", authed_user: { id: "U123" } },
      async (url) => {
        calls.push(url.toString());
        return {
          ok: true,
          async json() {
            return responses.shift();
          },
        };
      }
    );

    assert.deepEqual(calls, [`${SLACK_API_URI}auth.test`, `${SLACK_API_URI}users.info`]);
    assert.equal(result.team_id, "T123");
    assert.equal(result.team_name, "Example");
    assert.equal(result.authed_user_id, "U123");
  });

  it("allowed team id と一致しなければ失敗する", async () => {
    await assert.rejects(
      () =>
        verifyTokenAuthorization(
          { allowedTeamIds: ["T123"] },
          { access_token: "xoxp-test" },
          async () => ({
            ok: true,
            async json() {
              return { ok: true, team_id: "T999", user_id: "U123" };
            },
          })
        ),
      /許可されていない/
    );
  });

  it("guest user は常に拒否する", async () => {
    const responses = [
      { ok: true, team_id: "T123", team: "Example", user_id: "U123" },
      { ok: true, user: { id: "U123", is_restricted: true, is_ultra_restricted: false } },
    ];

    await assert.rejects(
      () =>
        verifyTokenAuthorization(
          { allowedTeamIds: ["T123"] },
          { access_token: "xoxp-test" },
          async () => ({
            ok: true,
            async json() {
              return responses.shift();
            },
          })
        ),
      /guest user/
    );
  });
});

describe("buildTokenRecord", () => {
  it("Slack response から保存 record を作る", () => {
    const record = buildTokenRecord(
      { clientId: "123.456" },
      {
        access_token: "xoxe.xoxp-1-token",
        refresh_token: "xoxe-1-refresh",
        expires_in: 43200,
        token_type: "user",
        team: { id: "T123", name: "Example" },
        authed_user: { id: "U123", scope: "channels:read" },
      },
      1000
    );

    assert.deepEqual(record, {
      version: 1,
      client_id: "123.456",
      team_id: "T123",
      team_name: "Example",
      authed_user_id: "U123",
      scope: "channels:read",
      access_token: "xoxe.xoxp-1-token",
      refresh_token: "xoxe-1-refresh",
      expires_at: 43201000,
      token_type: "user",
    });
  });

  it("auth.test の検証結果を token response より優先して保存する", () => {
    const record = buildTokenRecord(
      { clientId: "123.456" },
      {
        access_token: "xoxe.xoxp-1-token",
        refresh_token: "xoxe-1-refresh",
        expires_in: 43200,
        token_type: "user",
        team: { id: "TOLD", name: "Old" },
        authed_user: { id: "UOLD", scope: "channels:read" },
      },
      1000,
      {
        team_id: "T123",
        team_name: "Example",
        authed_user_id: "U123",
      }
    );

    assert.equal(record.team_id, "T123");
    assert.equal(record.team_name, "Example");
    assert.equal(record.authed_user_id, "U123");
  });
});

describe("explicit write opt-in", () => {
  it("--write 指定時のみ認証 URL に chat:write を含める", () => {
    for (const args of [[], ["--write"]]) {
      const options = parseArgs(args, {}, () => ({}));
      const url = buildAuthorizeUrl(options, { challenge: "test" }, "state");
      const scopes = url.searchParams.get("scope").split(",");
      assert.deepEqual(scopes, args.length ? [...READONLY_SCOPES, "chat:write"] : READONLY_SCOPES);
      assert.doesNotThrow(() => validateGrantedScopes({ scope: scopes.join(",") }, requestedScopes(options)));
    }
  });

  it("通常ログインで書き込み権限が残っていたら拒否する", () => {
    assert.throws(() => validateGrantedScopes({ scope: [...READONLY_SCOPES, "chat:write"].join(",") }), /要求していない scope/);
  });

  it("write ログインでも無関係の追加権限は拒否する", () => {
    assert.throws(() => validateGrantedScopes({ scope: [...READONLY_SCOPES, "chat:write", "files:write"].join(",") }, requestedScopes({ write: true })), /要求していない scope/);
  });

  it("--write の権限が付与されなければ成功扱いにしない", () => {
    assert.throws(() => validateGrantedScopes({ scope: READONLY_SCOPES.join(",") }, requestedScopes({ write: true })), /scope が不足.*chat:write/);
  });
});

describe("explicit reactions opt-in", () => {
  it("既定・投稿・リアクション・併用で要求する権限を分離する", () => {
    const { REACTION_SCOPES } = require("../oauth-login");
    assert.deepEqual(REACTION_SCOPES, ["reactions:read", "reactions:write"]);
    for (const [args, extra] of [
      [[], []], [["--write"], ["chat:write"]],
      [["--reactions"], REACTION_SCOPES],
      [["--write", "--reactions"], ["chat:write", ...REACTION_SCOPES]],
    ]) {
      const options = parseArgs(args, {}, () => ({}));
      const url = buildAuthorizeUrl(options, { challenge: "test" }, "state");
      assert.deepEqual(url.searchParams.get("scope").split(","), [...READONLY_SCOPES, ...extra]);
      assert.doesNotThrow(() => validateGrantedScopes({ scope: url.searchParams.get("scope") }, requestedScopes(options)));
    }
  });

  it("要求外のリアクション権限も、不足したリアクション権限も拒否する", () => {
    const withReactions = requestedScopes({ reactions: true });
    assert.throws(() => validateGrantedScopes({ scope: withReactions.join(",") }), /要求していない scope/);
    assert.throws(() => validateGrantedScopes({ scope: [...withReactions, "groups:history"].join(",") }, withReactions), /要求していない scope/);
    for (const missing of ["reactions:read", "reactions:write"]) {
      assert.throws(() => validateGrantedScopes({ scope: withReactions.filter(s => s !== missing).join(",") }, withReactions), /scope が不足/);
    }
  });
});

it("manifest の任意リアクション権限は宣言済みで、通常ログインの要求には含まれない", () => {
  const manifest = require("../../slack-app-manifest.json");
  const scopes = manifest.oauth_config.scopes;
  for (const scope of ["reactions:read", "reactions:write"]) {
    assert.ok(scopes.user.includes(scope), `${scope} must be declared`);
    assert.ok(scopes.user_optional.includes(scope), `${scope} must remain optional`);
    assert.ok(!requestedScopes().includes(scope), `${scope} must require opt-in`);
  }
});
