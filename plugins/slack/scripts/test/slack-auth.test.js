const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  parseAuthArgs,
  formatExpiresAt,
  getStatus,
  formatStatus,
  clearToken,
  formatClearResult,
  runAuth,
} = require("../slack-auth");

describe("parseAuthArgs", () => {
  it("引数なしは login として扱う", () => {
    assert.deepEqual(parseAuthArgs([]), { command: "login", rest: [] });
  });

  it("login option だけなら login へ渡す", () => {
    assert.deepEqual(parseAuthArgs(["--client-id", "123.456"]), {
      command: "login",
      rest: ["--client-id", "123.456"],
    });
  });

  it("status / clear をサブコマンドとして扱う", () => {
    assert.deepEqual(parseAuthArgs(["status"]), { command: "status", rest: [] });
    assert.deepEqual(parseAuthArgs(["clear"]), { command: "clear", rest: [] });
  });

  it("不明なサブコマンドを拒否する", () => {
    assert.throws(() => parseAuthArgs(["unknown"]), /不明なサブコマンド/);
    assert.throws(() => parseAuthArgs(["logout"]), /不明なサブコマンド/);
  });
});

describe("formatExpiresAt", () => {
  it("expires_at を ISO 文字列にする", () => {
    assert.equal(formatExpiresAt(1000), "1970-01-01T00:00:01.000Z");
  });

  it("不正値は unknown にする", () => {
    assert.equal(formatExpiresAt(0), "unknown");
    assert.equal(formatExpiresAt("not-date"), "unknown");
  });
});

describe("status", () => {
  it("token record がない場合は未保存として表示し、live check は呼ばない", async () => {
    const status = await getStatus({
      describeTokenStore: () => "test-store",
      readTokenRecord: async () => null,
      getSlackAccessToken: async () => {
        assert.fail("live check should not be called without a token record");
      },
    });

    assert.deepEqual(status, { exists: false, store: "test-store" });
    assert.equal(formatStatus(status), "Slack token は保存されていません。\nstore: test-store\n");
  });

  it("auth.test で live 確認し、token 値を出さずに team / user を表示する", async () => {
    const calls = [];
    const status = await getStatus({
      describeTokenStore: () => "test-store",
      readTokenRecord: async () => {
        calls.push({ fn: "readTokenRecord" });
        return {
          access_token: "xoxp-secret",
          refresh_token: "xoxe-refresh-secret",
          team_id: "TSTORED",
          team_name: "Stored",
          authed_user_id: "USTORED",
          scope: "channels:read",
          expires_at: 1000,
        };
      },
      getSlackAccessToken: async () => {
        calls.push({ fn: "getSlackAccessToken" });
        return "xoxp-secret";
      },
      fetchSlackApiWithToken: async (method, accessToken, params) => {
        calls.push({ fn: "fetchSlackApiWithToken", method, accessToken, params });
        return {
          ok: true,
          team: "Live",
          team_id: "TLIVE",
          user_id: "ULIVE",
          access_token: "xoxp-response-secret",
        };
      },
    });
    const output = formatStatus(status);

    assert.deepEqual(calls, [
      { fn: "readTokenRecord" },
      { fn: "getSlackAccessToken" },
      { fn: "fetchSlackApiWithToken", method: "auth.test", accessToken: "xoxp-secret", params: {} },
      { fn: "readTokenRecord" },
    ]);
    assert.match(output, /Slack token は保存されています/);
    assert.match(output, /live_check: auth\.test ok/);
    assert.match(output, /workspace: Live/);
    assert.match(output, /team_id: TLIVE/);
    assert.match(output, /user: ULIVE/);
    assert.doesNotMatch(output, /xoxp-secret/);
    assert.doesNotMatch(output, /xoxp-response-secret/);
    assert.doesNotMatch(output, /xoxe-refresh-secret/);
  });

  it("record はあるが access token を解決できなければ再ログインを促す", async () => {
    await assert.rejects(
      () =>
        getStatus({
          describeTokenStore: () => "test-store",
          readTokenRecord: async () => ({
            team_id: "T123",
            authed_user_id: "U123",
            scope: "channels:read",
            expires_at: 1000,
          }),
          getSlackAccessToken: async () => "",
          fetchSlackApiWithToken: async () => {
            assert.fail("auth.test should not be called without an access token");
          },
        }),
      /再ログイン/
    );
  });
});

describe("clear", () => {
  it("保存済み token record を削除する", async () => {
    const result = await clearToken({
      describeTokenStore: () => "test-store",
      deleteTokenRecord: async () => ({ deleted: true }),
    });
    const output = formatClearResult(result);

    assert.deepEqual(result, { deleted: true, store: "test-store" });
    assert.match(output, /削除しました/);
    assert.match(output, /revoke は行いません/);
  });

});

describe("runAuth", () => {
  it("引数なしで login を実行する", async () => {
    const output = await runAuth([], {
      parseLoginArgs: (args) => {
        assert.deepEqual(args, []);
        return { clientId: "123.456" };
      },
      oauthLogin: async (options) => ({
        store: "test-store",
        team: `team-for-${options.clientId}`,
        authedUserId: "U123",
        scope: "channels:read",
      }),
    });

    assert.match(output, /Slack token を保存しました/);
    assert.match(output, /workspace: team-for-123.456/);
  });

  it("login 明示でも login を実行する", async () => {
    const output = await runAuth(["login", "--client-id", "123.456"], {
      parseLoginArgs: (args) => {
        assert.deepEqual(args, ["--client-id", "123.456"]);
        return { clientId: "123.456" };
      },
      oauthLogin: async () => ({
        store: "test-store",
        team: "Example",
        authedUserId: "U123",
        scope: "channels:read",
      }),
    });

    assert.match(output, /workspace: Example/);
  });

  it("status に余分な引数があれば拒否する", async () => {
    await assert.rejects(
      () =>
        runAuth(["status", "extra"], {
          describeTokenStore: () => "test-store",
          readTokenRecord: async () => null,
        }),
      /status に引数/
    );
  });
});

it("login --write を実際の引数解析経由で OAuth に渡す", async () => {
  const { runAuth } = require("../slack-auth");
  const { parseArgs } = require("../oauth-login");
  for (const args of [["login"], ["login", "--write"], ["--write"]]) {
    let received;
    await runAuth(args, {
      parseLoginArgs: (rest) => parseArgs(rest, {}, () => ({})),
      oauthLogin: async (options) => {
        received = options;
        return { store: "test", team: "test", authedUserId: "U123", scope: "test" };
      },
    });
    assert.equal(received.write, args.includes("--write"));
  }
});
