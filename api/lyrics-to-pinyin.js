import { pinyin } from 'pinyin-pro';
import fetch from 'node-fetch';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  const { artist, title } = req.body;

  if (!artist || !title) {
    return res.status(400).json({ error: 'Missing title or artist' });
  }

  try {
    // STEP 1: Search NetEase
    const searchURL = `https://netease-cloud-music-api-seven-rho-51.vercel.app/search?keywords=${encodeURIComponent(`${artist} ${title}`)}`;
    const searchRes = await fetch(searchURL);
    const searchData = await searchRes.json();

    const song = searchData.result?.songs?.[0];
    if (!song || !song.id) {
      return res.status(404).json({ error: 'Song not found' });
    }

    // STEP 2: Fetch lyrics
    const lyricURL = `https://netease-cloud-music-api-seven-rho-51.vercel.app/lyric?id=${song.id}`;
    const lyricRes = await fetch(lyricURL);
    const lyricData = await lyricRes.json();

    const rawLyrics = lyricData.lrc?.lyric || '';

    // STEP 3: Parse + pinyin
    const lines = rawLyrics
      .split('\n')
      .map(line => line.replace(/\[\d{2}:\d{2}(?:\.\d{2})?\]/g, '').trim())
      .filter(Boolean)
      .map(line => ({
        original: line,
        pinyin: pinyin(line, { toneType: 'symbol', type: 'array' }).join(' ')
      }));

    return res.status(200).json({
      song: {
        title: song.name,
        artist: song.artists?.[0]?.name || artist,
        id: song.id
      },
      lines
    });
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
