const axios = require("axios");
const { Redis } = require("@upstash/redis");
const { waitUntil } = require("@vercel/functions");

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;
const LINKS_URL = process.env.LINKS_URL;

const GRAPH = "https://graph.instagram.com/v19.0";
const redis = Redis.fromEnv();

// ===== LINKS =====
let linksCache = { data: {}, at: 0 };
const LINKS_TTL_MS = 60_000;

async function getLinks() {
  const fresh = Date.now() - linksCache.at < LINKS_TTL_MS;
  if (fresh && Object.keys(linksCache.data).length) return linksCache.data;

  try {
    const res = await axios.get(LINKS_URL, { timeout: 5000 });
    if (res.data && typeof res.data === "object") {
      linksCache = { data: res.data, at: Date.now() };
      console.log("Links loaded:", Object.keys(res.data).length);
    } else {
      console.log("Invalid JSON format from LINKS_URL");
    }
  } catch (err) {
    console.log("Failed to load links:", err.message);
  }
  return linksCache.data;
}

// ===== DEDUPE =====
async function claimComment(commentId) {
  const ok = await redis.set(`dm:comment:${commentId}`, 1, {
    nx: true,
    ex: 60 * 60 * 24 * 7,
  });
  return ok === "OK";
}

// ===== REPLY VARIANTS =====
const NON_FOLLOWER_REPLIES = [
  "Please follow & add a new comment to get the link in DM 🙏",
  "Follow me first, then comment on this reel again to receive the DM 📲",
  "Hit follow, then drop a new comment on this reel and I'll DM you ✅",
  "Follow the account & comment again on this reel to get the link 🔗",
  "Follow first, then add a new comment here and the DM magic happens ✨",
];

const getRandomNonFollowerReply = () =>
  NON_FOLLOWER_REPLIES[Math.floor(Math.random() * NON_FOLLOWER_REPLIES.length)];

const DM_SENT_REPLIES = [
  "Link landed in your DM 📩",
  "Check out DM for link 📨",
  "Done, sent to your DM ✅",
  "Grab the link from DM 🔗",
  "Link sent, happy learning 📚",
  "Link is in your DM now 📥",
  "Check your DM for link 👀",
  "Sent the link, check your DM 📤",
  "Get your link from DM 🎯",
  "Done and dusted, link sent 🙌",
];

const getRandomReply = () =>
  DM_SENT_REPLIES[Math.floor(Math.random() * DM_SENT_REPLIES.length)];

// ===== HELPERS =====
async function isFollowingMe(userId) {
  try {
    const res = await axios.get(`${GRAPH}/${userId}`, {
      params: {
        fields: "is_user_follow_business",
        access_token: PAGE_ACCESS_TOKEN,
      },
    });
    console.log("🔍 Follow check:", userId, JSON.stringify(res.data));
    return res.data.is_user_follow_business === true;
  } catch (err) {
    console.log("❌ Follow check error:", err.response?.data || err.message);
    return false;
  }
}

function shouldTrigger(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (/^[^\p{L}\p{N}]+$/u.test(trimmed)) return true;
  return trimmed.split(/\s+/).length <= 3;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== JOB PROCESSING =====
async function processJob(job) {
  const isFollower = await isFollowingMe(job.user_id);
  if (!isFollower) {
    console.log("⚠️ Non-follower, sending comment:", job.user_id);
    try {
      await axios.post(
        `${GRAPH}/${job.comment_id}/replies`,
        { message: getRandomNonFollowerReply() },
        { params: { access_token: PAGE_ACCESS_TOKEN } }
      );
      console.log("✅ Non-follower reply sent");
    } catch (err) {
      console.log("❌ Non-follower reply error:", err.response?.data || err.message);
    }
    return;
  }

  console.log("🚀 Processing:", job.user_id, job.reel_id, "🔗", job.link);

  let dmSuccess = true;
  try {
    await axios.post(
      `${GRAPH}/${IG_USER_ID}/messages`,
      {
        recipient: { comment_id: job.comment_id },
        message: { text: `${job.link}` },
      },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );
    console.log("✅ DM sent:", job.user_id);
  } catch (err) {
    dmSuccess = false;
    console.log("❌ DM error:", err.response?.data || err.message);
  }

  try {
    const replyMessage = dmSuccess
      ? getRandomReply()
      : "Auto send failed, please share the reel in my DM, will respond there";

    await axios.post(
      `${GRAPH}/${job.comment_id}/replies`,
      { message: replyMessage },
      { params: { access_token: PAGE_ACCESS_TOKEN } }
    );
    console.log("✅ Comment reply sent:", replyMessage);
  } catch (err) {
    console.log("❌ Reply error:", err.response?.data || err.message);
  }
}

// ===== EVENT HANDLER =====
async function handleEvent(body) {
  const links = await getLinks();
  const jobs = [];

  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "comments") continue;

      const c = change.value || {};
      const reelId = String(c.media?.id || "");
      const userId = c.from?.id;

      console.log("---- NEW COMMENT ----");
      console.log("User:", userId, c.from?.username);
      console.log("Reel:", reelId, "| Text:", c.text);

      if (!reelId || !userId) {
        console.log("❌ Missing reelId/userId");
        continue;
      }
      if (userId === IG_USER_ID) {
        console.log("⚠️ Skipping self comment");
        continue;
      }
      if (!shouldTrigger(c.text)) {
        console.log("⚠️ Skipped (trigger rule):", c.text);
        continue;
      }
      if (!links[reelId]) {
        console.log("❌ Unmapped reel skipped:", reelId);
        continue;
      }
      if (!(await claimComment(c.id))) {
        console.log("⚠️ Duplicate skipped:", c.id);
        continue;
      }

      console.log("✅ Queued:", userId, reelId, "comment:", c.id);
      jobs.push({
        user_id: userId,
        comment_id: c.id,
        reel_id: reelId,
        link: links[reelId],
      });
    }
  }

  for (let i = 0; i < jobs.length; i++) {
    await processJob(jobs[i]);
    if (i < jobs.length - 1) await sleep(2000);
  }
}

// ===== HANDLER =====
module.exports = async (req, res) => {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method === "POST") {
    console.log("WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

    res.status(200).send("EVENT_RECEIVED");
    waitUntil(
      handleEvent(req.body).catch((err) =>
        console.log("❌ Webhook processing error:", err.message)
      )
    );
    return;
  }

  return res.status(405).end();
};
