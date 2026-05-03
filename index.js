const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIG =====
const VERIFY_TOKEN = "myverifytoken";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

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
  const entries = req.body.entry || [];

  entries.forEach(entry => {
    const changes = entry.changes || [];

    changes.forEach(change => {
      if (change.field === "comments") {
        const c = change.value;

        const reelId = String(c.media?.id); // 🔥 FORCE STRING
        const userId = c.from?.id;

        console.log("Incoming reel:", reelId);
        console.log("Comment text:", c.text);

        if (!shouldTrigger(c.text)) {
          console.log("Skipped (trigger rule):", c.text);
          return;
        }

        // 🔥 DEBUG mapping
        console.log("Checking mapping for:", reelId);
        console.log("Available keys:", Object.keys(REEL_LINKS));

        // Skip if no reel or not mapped
        if (!reelId || !REEL_LINKS[reelId]) {
          console.log("❌ Unmapped reel skipped:", reelId);
          return;
        }

        // Init user set
        if (!sentMap.has(userId)) {
          sentMap.set(userId, new Set());
        }

        const userReels = sentMap.get(userId);

        // Duplicate check
        if (userReels.has(reelId)) {
          console.log("⚠️ Duplicate skipped:", userId, reelId);
          return;
        }

        // Mark as sent
        userReels.add(reelId);

        console.log("✅ Added to queue:", userId, reelId);

        // Add to queue
        queue.push({
          user_id: userId,
          comment_id: c.id,
          reel_id: reelId
        });
      }
    });
  });

  processQueue();
  res.sendStatus(200);
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
        `https://graph.facebook.com/v19.0/me/messages`,
        {
          recipient: { id: job.user_id },
          message: { text: `Here’s the link 👇 ${link}` }
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