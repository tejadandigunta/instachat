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
  if (isEmojiOnly) return false;

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

app.get("/reels", (req, res) => {
  res.sendFile(__dirname + "/reels.html");
});

app.get("/reels-data", async (req, res) => {
  try {
    const response = await axios.get(
      `https://graph.instagram.com/v19.0/${IG_USER_ID}/media`,
      {
        params: {
          fields: "id,media_type,media_product_type,permalink,timestamp,caption",
          access_token: PAGE_ACCESS_TOKEN,
          limit: 50
        }
      }
    );
    const reels = response.data.data.filter(m => m.media_product_type === "REELS");
    res.json(reels);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

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

        // 🚫 Skip reply comments — private reply API only works on top-level comments
        if (c.parent_id) {
          console.log("⚠️ Skipping reply comment (has parent_id):", c.id);
          return;
        }

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

  try {
    while (queue.length > 0) {
      const job = queue.shift();

      if (!PAGE_ACCESS_TOKEN) {
        console.log("Missing token");
        continue;
      }

      const link = REEL_LINKS[job.reel_id];
      console.log("🚀 Processing:", job.user_id, job.reel_id);
      console.log("🔗 Link:", link);

      let dmSuccess = true;

      try {
        await axios.post(
          `https://graph.instagram.com/v19.0/${IG_USER_ID}/messages`,
          {
            recipient: { comment_id: job.comment_id },
            message: { text: `Here's the link: ${link}` }
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
          ? "Sent in DM ✅"
          : "Unable to send you a DM due to your account restrictions 🔒 Please open your DMs and try again!";

        await axios.post(
          `https://graph.instagram.com/v19.0/${job.comment_id}/replies`,
          { message: replyMessage },
          { params: { access_token: PAGE_ACCESS_TOKEN } }
        );
        console.log("✅ Comment reply sent");
      } catch (err) {
        console.log("❌ Reply error:", err.response?.data || err.message);
      }

      await new Promise(r => setTimeout(r, 3000));
    }
  } finally {
    processing = false;  // ← always resets, even if something throws
  }
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Running on", PORT);
});
