const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIG =====
const VERIFY_TOKEN = "myverifytoken";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const IG_USER_ID = "17841443788151017"; 

// 👉 PUT YOUR GITHUB RAW JSON URL HERE
const LINKS_URL = "https://raw.githubusercontent.com/tejadandigunta/instachat-config/refs/heads/main/reel-links.json";

// ===== IN-MEMORY STATE =====
let REEL_LINKS = {}; // loaded from GitHub
const sentMap = new Map(); // user_id → Set of reel_ids

// ===== LOAD LINKS =====
async function loadLinks() {
  try {
    const res = await axios.get(LINKS_URL, { timeout: 5000 });

    if (typeof res.data === "object" && res.data !== null) {
      REEL_LINKS = res.data;

      console.log("Links loaded:", Object.keys(REEL_LINKS).length);
      console.log("Available keys:", Object.keys(REEL_LINKS)); // 🔥 DEBUG
    } else {
      console.log("Invalid JSON format from LINKS_URL");
    }
  } catch (err) {
    console.log("Failed to load links:", err.message);
  }
}

// Load at startup
loadLinks();

// Refresh every 60 seconds
setInterval(loadLinks, 60000);

// ===== HELPER: TRIGGER LOGIC =====
function shouldTrigger(text) {
  if (!text) return false;

  const trimmed = text.trim();

  // Emoji-only (no letters or numbers)
  const isEmojiOnly = /^[^\p{L}\p{N}]+$/u.test(trimmed);
  if (isEmojiOnly) return true;

  // Word count
  const words = trimmed.split(/\s+/);
  return words.length <= 3;
}

// ===== HEALTH CHECK =====
app.get("/", (req, res) => {
  res.send("OK ROOT");
});

// ===== WEBHOOK VERIFY =====
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== QUEUE =====
const queue = [];
let processing = false;

// ===== RECEIVE EVENTS =====
app.post("/webhook", (req, res) => {
  // ✅ Always respond immediately (VERY IMPORTANT)
  res.sendStatus(200);

  console.log("WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

  try {
    const entries = req.body.entry || [];

    entries.forEach(entry => {
      const changes = entry.changes || [];

      changes.forEach(change => {
        if (change.field !== "comments") return;

        const c = change.value;

        const reelId = String(c.media?.id);
        const userId = c.from?.id;
        const username = c.from?.username;
        const text = c.text;

        console.log("---- NEW COMMENT ----");
        console.log("User:", userId, username);
        console.log("Reel:", reelId);
        console.log("Text:", text);

        // 🚫 Skip if missing data
        if (!reelId || !userId) {
          console.log("❌ Missing reelId/userId");
          return;
        }

        // 🚫 Skip your own comments
        if (userId === IG_USER_ID) {
          console.log("⚠️ Skipping self comment");
          return;
        }

       // 🎯 Trigger rule
        if (!shouldTrigger(text)) {
        console.log("⚠️ Skipped (trigger rule):", text);
        return;
        }

        // 🔍 Mapping check
        console.log("Checking mapping for:", reelId);
        console.log("Available keys:", Object.keys(REEL_LINKS));

        if (!REEL_LINKS[reelId]) {
        console.log("❌ Unmapped reel skipped:", reelId);
        return;
        }

        // 🔁 Duplicate protection (based on comment_id)
        if (!sentMap.has("comments")) {
        sentMap.set("comments", new Set());
        }

        const processedComments = sentMap.get("comments");

        if (processedComments.has(c.id)) {
        console.log("⚠️ Duplicate skipped:", c.id);
        return;
        }

        processedComments.add(c.id);

        console.log("✅ Added to queue:", userId, reelId, "comment:", c.id);

        // 🚀 Push to queue
        queue.push({
          user_id: userId,
          comment_id: c.id,
          reel_id: reelId
        });
      });
    });

    // 🚀 Start processing
    processQueue();

  } catch (err) {
    console.log("❌ Webhook processing error:", err.message);
  }
});

// ===== PROCESS QUEUE =====
async function processQueue() {
  if (processing) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();

    try {
      if (!PAGE_ACCESS_TOKEN) {
        console.log("Missing token");
        continue;
      }

      const link = REEL_LINKS[job.reel_id];

      console.log("🚀 Processing:", job.user_id, job.reel_id);
      console.log("🔗 Link:", link);

      // ===== DM =====
      await axios.post(
        `https://graph.facebook.com/v19.0/${IG_USER_ID}/messages`,
        {
          recipient: { comment_id: job.comment_id },
          message: { text: `Here's the link 👇 ${link}` }
        },
        {
            params: { access_token: PAGE_ACCESS_TOKEN }
        }
    );

      // ===== COMMENT REPLY =====
      await axios.post(
        `https://graph.facebook.com/v19.0/${job.comment_id}/replies`,
        {
          message: "Sent you DM ✅"
        },
        {
          params: { access_token: PAGE_ACCESS_TOKEN }
        }
      );

      console.log("✅ Done:", job.user_id);

    } catch (err) {
      console.log("❌ Error:", err.response?.data || err.message);
    }

    // Rate limit
    await new Promise(r => setTimeout(r, 3000));
  }

  processing = false;
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Running on", PORT);
});
