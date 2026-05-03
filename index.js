const express = require("express");

const app = express();

app.get("/", (req, res) => {
  res.send("OK ROOT");
});

app.get("/webhook", (req, res) => {
  return res.send("WEBHOOK WORKING");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on", PORT));