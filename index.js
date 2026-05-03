const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

const app = express();
app.use(bodyParser.json());

app.get("/", (req, res) => {
  res.send("OK");
});

const VERIFY_TOKEN = "myverifytoken";
const PAGE_ACCESS_TOKEN = "process.env.PAGE_ACCESS_TOKEN";

// ===== WEBHOOK VERIFY =====
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === "myverifytoken") {
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(500);
  }
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

    if (!PAGE_ACCESS_TOKEN) {
    console.log("Missing token");
    continue;
  }


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