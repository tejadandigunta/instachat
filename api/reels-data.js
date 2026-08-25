const axios = require("axios");

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const IG_USER_ID = process.env.IG_USER_ID;

module.exports = async (req, res) => {
  try {
    const response = await axios.get(
      `https://graph.instagram.com/v19.0/${IG_USER_ID}/media`,
      {
        params: {
          fields: "id,media_type,media_product_type,permalink,timestamp,caption",
          access_token: PAGE_ACCESS_TOKEN,
          limit: 50,
        },
      }
    );
    const reels = response.data.data.filter(
      (m) => m.media_product_type === "REELS"
    );
    res.status(200).json(reels);
  } catch (err) {
    console.log("❌ /reels-data error:", err.response?.data || err.message);
    const message = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: { message } });
  }
};
