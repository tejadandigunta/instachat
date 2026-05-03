const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

// 👇 IMPORTANT: bind to 0.0.0.0
app.listen(PORT, "0.0.0.0", () => {
  console.log("Running on", PORT);
});

app.get("/", (req, res) => {
  res.send("OK ROOT");
});

app.get("/webhook", (req, res) => {
  res.send("WEBHOOK OK");
});