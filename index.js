const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIG =====
const VERIFY_TOKEN = "myverifytoken";
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;

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

        if (!c.text || c.text.length < 2) return;

        queue.push({
          user_id: c.from.id,
          comment_id: c.id
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

      // DM
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

      // Comment reply
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

    await new Promise(r => setTimeout(r, 3000));
  }

  processing = false;
}

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Running on", PORT);
});