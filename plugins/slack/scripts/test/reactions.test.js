"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, runReactions } = require("../reactions");

const ts = "1786603301.830739";
const url = "https://example.slack.com/archives/C123/p1786603301830739?thread_ts=1786524936.703549";
const publicChannel = {
  id: "C123", is_channel: true, is_private: false, is_im: false,
  is_mpim: false, is_member: true, is_archived: false,
};

function api({ channel = publicChannel, reactions = [], response = { ok: true }, getError } = {}) {
  const calls = [];
  return {
    calls,
    fetchSlackApi: async (method, params) => {
      calls.push({ method, params });
      if (method === "conversations.info") return { ok: true, channel };
      assert.equal(method, "reactions.get");
      if (getError) return { ok: false, error: getError };
      return { ok: true, type: "message", channel: "C123", message: { ts, text: "omit this body", reactions } };
    },
    fetchSlackApiJson: async (method, params, options) => {
      calls.push({ method, params, options });
      return response;
    },
  };
}

describe("reaction target parsing", () => {
  it("スレッド内の投稿 URL は thread_ts ではなく対象投稿を指定する", () => {
    assert.deepEqual(parseArgs(["add", url, ":in_review:"]), {
      action: "add", channel: "C123", timestamp: ts, name: "in_review",
    });
    assert.deepEqual(parseArgs(["remove", "C123", ts, "in_review"]), {
      action: "remove", channel: "C123", timestamp: ts, name: "in_review",
    });
  });

  it("絵文字名・引数・対象が曖昧なら拒否する", () => {
    for (const args of [
      [], ["delete", url, "in_review"], ["add", url], ["add", url, ""],
      ["get", url, "in_review"], ["remove", url, "in_review", "extra"],
      ["add", url, "👍"], ["add", url, "in review"], ["add", url, "--help"],
      ["get", "C123", "1786603301"], ["get", "C123", ts, "extra"],
      ["get", "D123", ts], ["get", "G123", ts],
      ["get", url.replace("example.slack.com", "slack.com.evil.example")],
      ["get", url.replace("example.slack.com", "example.slack.com:8443")],
      ["get", url.replace("C123", "D123")],
    ]) assert.throws(() => parseArgs(args), undefined, JSON.stringify(args));
  });
});

describe("reaction access policy", () => {
  it("全操作で private / DM / 不明な種別を reactions API 呼び出し前に拒否する", async () => {
    const denied = [
      null, {}, { ...publicChannel, id: "C999" },
      { ...publicChannel, is_private: true }, { ...publicChannel, is_private: undefined },
      { ...publicChannel, is_channel: false }, { ...publicChannel, is_im: true },
      { ...publicChannel, is_mpim: true }, { ...publicChannel, is_im: undefined },
    ];
    for (const action of ["get", "add", "remove"]) {
      for (const channel of denied) {
        const mock = api({ channel });
        const args = action === "get" ? [action, url] : [action, url, "in_review"];
        await assert.rejects(() => runReactions(args, mock), /public チャンネル/);
        assert.deepEqual(mock.calls.map(c => c.method), ["conversations.info"]);
      }
    }
  });

  it("変更は参加済み・未アーカイブが確認できなければ拒否する", async () => {
    for (const action of ["add", "remove"]) {
      for (const fields of [{ is_member: false }, { is_member: undefined }, { is_archived: true }, { is_archived: undefined }]) {
        const mock = api({ channel: { ...publicChannel, ...fields } });
        await assert.rejects(() => runReactions([action, url, "in_review"], mock), /参加済み/);
        assert.equal(mock.calls.length, 1);
      }
    }
  });

  it("チャンネル情報の取得失敗時にはリアクションを取得・変更しない", async () => {
    let postCalls = 0;
    await assert.rejects(() => runReactions(["add", url, "in_review"], {
      fetchSlackApi: async () => { throw new Error("channel_not_found"); },
      fetchSlackApiJson: async () => { postCalls++; },
    }), /channel_not_found/);
    assert.equal(postCalls, 0);
  });
});

describe("reaction operations", () => {
  it("get は本文を出さず count を保持する（users 配列は全員を含むとは限らない）", async () => {
    const reactions = [{ name: "in_review", count: 2, users: ["U1"] }];
    const mock = api({ reactions });
    const result = await runReactions(["get", url], mock);
    assert.deepEqual(result, { action: "get", channel: "C123", timestamp: ts, reactions });
    assert.doesNotMatch(JSON.stringify(result), /omit this body/);
    assert.deepEqual(mock.calls, [
      { method: "conversations.info", params: { channel: "C123" } },
      { method: "reactions.get", params: { channel: "C123", timestamp: ts, full: "true" } },
    ]);
  });

  it("リアクションのない投稿は空配列を返す", async () => {
    const result = await runReactions(["get", "C123", ts], api());
    assert.deepEqual(result.reactions, []);
  });

  it("add / remove は指定の投稿と絵文字だけを POST する", async () => {
    for (const action of ["add", "remove"]) {
      const mock = api();
      const result = await runReactions([action, url, ":in_review:"], mock);
      assert.equal(result.status, action === "add" ? "added" : "removed");
      assert.deepEqual(mock.calls[1], {
        method: `reactions.${action}`,
        params: { channel: "C123", timestamp: ts, name: "in_review" },
        options: { skipCheck: true },
      });
      assert.equal(mock.calls.length, 2);
    }
  });

  it("既に付与済み・削除済みは新たな変更と区別し、再試行しない", async () => {
    for (const [action, error] of [["add", "already_reacted"], ["remove", "no_reaction"]]) {
      const mock = api({ response: { ok: false, error } });
      const result = await runReactions([action, url, "in_review"], mock);
      assert.equal(result.status, error);
      assert.equal(mock.calls.length, 2);
    }
  });

  it("権限不足・レート制限・不明な絵文字を成功扱いせず、再試行しない", async () => {
    for (const action of ["get", "add", "remove"]) {
      for (const error of ["missing_scope", "ratelimited", "invalid_name"]) {
        const mock = api({ response: { ok: false, error }, getError: error });
        const args = action === "get" ? [action, url] : [action, url, "in_review"];
        await assert.rejects(() => runReactions(args, mock), error === "missing_scope" ? /login --reactions/ : new RegExp(error));
        assert.equal(mock.calls.length, 2);
      }
    }
  });

  it("help と不正な引数では API を呼ばない", async () => {
    const mock = api();
    assert.match(await runReactions(["--help"], mock), /使い方/);
    await assert.rejects(() => runReactions(["add", url], mock));
    assert.equal(mock.calls.length, 0);
  });
});
