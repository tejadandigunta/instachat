const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = "myverifytoken";
const PAGE_ACCESS_TOKEN = "PASTE_YOUR_TOKEN_HERE";

// ===== WEBHOOK VERIFY =====
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

// ===== SIMPLE QUEUE =====
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

        if (!c.text || c.text.length < 2) return; // skip emojis

        queue.push({
          user_id: c.from.id,
          comment_id: c.id,
          text: c.text
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
      // SEND DM
      await axios.post(
        `https://graph.facebook.com/v19.0/me/messages`,
        {
          recipient: { id: job.user_id },
          message: { text: "Here’s the link 👇 YOUR_LINK" }
        },
        {
          params: { access_token: PAGE_ACCESS_TOKEN }
        }
      );

      // REPLY COMMENT
      await axios.post(
        `https://graph.facebook.com/v19.0/${job.comment_id}/replies`,
        {
          message: "Sent you DM ✅"
        },
        {
          params: { access_token: PAGE_ACCESS_TOKEN }
        }
      );

      console.log("Done:", job.user_id);

    } catch (err) {
      console.log("Error:", err.response?.data || err.message);
    }

    // RATE LIMIT (VERY IMPORTANT)
    await new Promise(r => setTimeout(r, 3000));
  }

  processing = false;
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running"));