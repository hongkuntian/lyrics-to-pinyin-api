import { pinyin } from "pinyin-pro";
import fetch from "node-fetch";
import { Redis } from "@upstash/redis";
import "dotenv/config";

const redis = new Redis({
  url: process.env.REDIS_URL,
  token: process.env.KV_REST_API_TOKEN,
});

export default async function handler(req, res) {
  console.log("🔑 Redis URL:", process.env.REDIS_URL);
  
  // Validate Redis configuration
  if (!process.env.REDIS_URL || !process.env.KV_REST_API_TOKEN) {
    console.error("❌ Missing Upstash Redis environment variables");
    return res.status(500).json({ 
      error: "Redis configuration missing. Please check your environment variables." 
    });
  }

  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  const { artist, title } = req.body;

  if (!artist || !title) {
    return res.status(400).json({ error: "Missing title or artist" });
  }

  const cacheKey = `lyrics:${artist.trim()}-${title.trim()}`;

  try {
    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    // Proceed with lookup if not cached
    const searchURL = `https://netease-cloud-music-api-seven-rho-51.vercel.app/search?keywords=${encodeURIComponent(
      `${artist} ${title}`
    )}`;
    const searchRes = await fetch(searchURL);
    const searchData = await searchRes.json();

    if (searchData.code !== 200 || !searchData.result?.songs?.length) {
      return res.status(404).json({ error: "Song not found in Netease" });
    }

    const song = searchData.result.songs[0];
    const songTitle = song.name;
    const songArtist = song.artists?.[0]?.name || artist;

    const lyricURL = `https://netease-cloud-music-api-seven-rho-51.vercel.app/lyric?id=${song.id}`;
    const lyricRes = await fetch(lyricURL);
    const lyricData = await lyricRes.json();

    if (lyricData.code !== 200 || !lyricData.lrc?.lyric) {
      return res.status(404).json({ error: "Lyrics not found" });
    }

    const rawLyrics = lyricData.lrc.lyric;

    const lines = rawLyrics
      .split("\n")
      .map((line) => line.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, "").trim())
      .filter((line) => line && !/[：:]/.test(line))
      .map((line) => ({
        original: line,
        pinyin: pinyin(line, { toneType: "symbol", type: "array" }).join(" "),
      }));

    const response = {
      song: {
        title: {
          original: songTitle,
          pinyin: pinyin(songTitle, { toneType: "symbol", type: "array" }).join(
            " "
          ),
        },
        artist: {
          original: songArtist,
          pinyin: pinyin(songArtist, {
            toneType: "symbol",
            type: "array",
          }).join(" "),
        },
        id: song.id,
      },
      lines,
    };

    // Store in Redis (no expiry)
    await redis.set(cacheKey, response);

    return res.status(200).json(response);
  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
