const { pinyin } = require("pinyin-pro");
const fetch = require("node-fetch");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { artist, title } = req.body;

  if (!artist || !title) {
    return res.status(400).json({ error: "Missing title or artist" });
  }

  try {
    const searchURL = `https://netease-cloud-music-api-seven-rho-51.vercel.app/search?keywords=${encodeURIComponent(
      `${artist} ${title}`
    )}`;
    const searchRes = await fetch(searchURL);
    const searchData = await searchRes.json();

    if (searchData.code !== 200 || !searchData.result?.songs?.length) {
      return res.status(404).json({ error: "Song not found in Netease" });
    }

    const song = searchData.result.songs[0];

    const lyricURL = `https://netease-cloud-music-api-seven-rho-51.vercel.app/lyric?id=${song.id}`;
    const lyricRes = await fetch(lyricURL);
    const lyricData = await lyricRes.json();

    if (lyricData.code !== 200 || !lyricData.lrc?.lyric) {
      return res.status(404).json({ error: "Lyrics not found" });
    }

    const rawLyrics = lyricData.lrc.lyric;

    const lines = rawLyrics
      .split("\n")
      .map((line) => line.replace(/\[\d{2}:\d{2}(?:\.\d{2})?\]/g, "").trim())
      .filter(Boolean)
      .map((line) => ({
        original: line,
        pinyin: pinyin(line, { toneType: "symbol", type: "array" }).join(" "),
      }));

    return res.status(200).json({
      song: {
        title: song.name,
        artist: song.artists?.[0]?.name || artist,
        id: song.id,
      },
      lines,
    });
  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};
