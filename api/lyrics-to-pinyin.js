import { pinyin } from "pinyin-pro";
import fetch from "node-fetch";

export default async function handler(req, res) {
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
      .map((line) => line.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, "").trim()) // remove timestamps
      .filter((line) => line && !line.includes(":")) // filter metadata lines
      .map((line) => ({
        original: line,
        pinyin: pinyin(line, { toneType: "symbol", type: "array" }).join(" "),
      }));

    return res.status(200).json({
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
    });
  } catch (err) {
    console.error("API error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
