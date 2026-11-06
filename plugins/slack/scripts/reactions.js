"use strict";

const { fetchSlackApi, fetchSlackApiJson } = require("./common");

const USAGE = [
  "使い方: reactions.js <get|add|remove> <Slack メッセージURL> [emoji]",
  "または: reactions.js <get|add|remove> <channel ID> <timestamp> [emoji]",
  "",
  "get はリアクションを取得します。add / remove は指定した絵文字を追加 / 削除します。",
  "変更は参加済み public チャンネルのみ。remove は認証ユーザー自身のリアクションのみです。",
  "事前に slack-auth login --reactions で認証してください。",
  "",
].join("\n");

function parseArgs(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const [action, target, ...rest] = args;
  if (!["get", "add", "remove"].includes(action) || !target) throw new Error(USAGE);
  let channel, timestamp;
  if (target.startsWith("https://")) {
    const url = new URL(target);
    if (!url.hostname.endsWith(".slack.com") || url.port || url.username || url.password) {
      throw new Error("Slack メッセージURL を指定してください。");
    }
    const match = url.pathname.match(/^\/archives\/(C[A-Z0-9]+)\/p(\d{7,})\/?$/);
    if (!match) throw new Error("public チャンネルのメッセージURL を指定してください。");
    channel = match[1];
    // thread_ts ではなく、URL が指す投稿そのものを対象にする。
    timestamp = `${match[2].slice(0, -6)}.${match[2].slice(-6)}`;
  } else {
    channel = target;
    timestamp = rest.shift();
  }
  if (!/^C[A-Z0-9]+$/.test(channel) || !/^\d+\.\d{6}$/.test(timestamp || "")) {
    throw new Error("public チャンネル ID と正確な timestamp を指定してください。");
  }
  if (rest.length !== (action === "get" ? 0 : 1)) throw new Error(USAGE);
  let name = rest[0];
  if (name) {
    name = name.replace(/^:([^:]+):$/, "$1");
    if (name.startsWith("--") || !/^[A-Za-z0-9_+\-]+(?:::skin-tone-[2-6])?$/.test(name)) {
      throw new Error("絵文字名を指定してください（例: in_review または :in_review:）。");
    }
  }
  if (action !== "get" && !name) throw new Error(USAGE);
  return { action, channel, timestamp, ...(name ? { name } : {}) };
}

function assertAllowedChannel(channel, target, action) {
  // C 始まりの private もある。キャッシュや ID の先頭文字だけでは許可しない。
  if (!channel || channel.id !== target || channel.is_channel !== true ||
      channel.is_private !== false || channel.is_im !== false || channel.is_mpim !== false) {
    throw new Error("public チャンネルであることを確認できないため操作しません。");
  }
  if (action !== "get" && (channel.is_member !== true || channel.is_archived !== false)) {
    throw new Error("変更できるのは参加済み・未アーカイブの public チャンネルのみです。");
  }
}

function checkResponse(data) {
  if (data.ok) return;
  if (data.error === "missing_scope") {
    throw new Error("必要な scope がありません。Slack App の設定・再インストール後、slack-auth login --reactions で再認証してください。");
  }
  throw new Error(`Slack API エラー: ${data.error || "不明なエラー"}`);
}

async function runReactions(args, options = {}) {
  const parsed = parseArgs(args);
  if (parsed.help) return USAGE;
  const { action, channel, timestamp, name } = parsed;
  const get = options.fetchSlackApi || fetchSlackApi;
  const post = options.fetchSlackApiJson || fetchSlackApiJson;
  const info = await get("conversations.info", { channel });
  checkResponse(info);
  assertAllowedChannel(info.channel, channel, action);

  if (action === "get") {
    const data = await get("reactions.get", { channel, timestamp, full: "true" });
    checkResponse(data);
    if (data.type !== "message" || data.channel !== channel || data.message?.ts !== timestamp) {
      throw new Error("対象メッセージのリアクションを確認できませんでした。");
    }
    // reactions.get は本文も返すが、出力には必要なリアクション情報だけを含める。
    return {
      action, channel, timestamp,
      reactions: (data.message.reactions || []).map(({ name, count, users }) => ({ name, count, users })),
    };
  }

  const data = await post(`reactions.${action}`, { channel, timestamp, name }, { skipCheck: true });
  const unchanged = action === "add" ? "already_reacted" : "no_reaction";
  if (!data.ok && data.error === unchanged) {
    return { action, channel, timestamp, name, status: unchanged };
  }
  checkResponse(data);
  return { action, channel, timestamp, name, status: action === "add" ? "added" : "removed" };
}

async function main() {
  try {
    const result = await runReactions(process.argv.slice(2));
    process.stdout.write(typeof result === "string" ? result : `${JSON.stringify(result, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`エラー: ${err.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { USAGE, parseArgs, assertAllowedChannel, runReactions };
