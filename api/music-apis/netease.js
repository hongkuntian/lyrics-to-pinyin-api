import fetch from "node-fetch";
import { BaseMusicAPI } from "./base.js";

export class NeteaseAPI extends BaseMusicAPI {
  constructor() {
    super("NeteaseAPI", ["zh", "yue", "en"]); // Supports Chinese (Mandarin and Cantonese) and English
    this.baseURL = "https://netease-cloud-music-api-gules-mu.vercel.app";
  }

  async searchSong(artist, title) {
    try {
      const searchURL = `${this.baseURL}/search?keywords=${encodeURIComponent(
        `${artist} ${title}`
      )}`;
      
      const response = await fetch(searchURL);
      
      if (!response.ok) {
        return null;
      }
      
      const data = await response.json();

      if (data.code !== 200 || !data.result?.songs?.length) {
        return null;
      }

      const song = data.result.songs[0];
      return {
        id: song.id,
        title: song.name,
        artist: song.artists?.[0]?.name || artist,
        album: song.album?.name,
        duration: song.duration ? Math.floor(song.duration / 1000) : null, // Convert from milliseconds to seconds
        source: "netease"
      };
    } catch (error) {
      return null;
    }
  }

  async getLyrics(songId) {
    try {
      const lyricURL = `${this.baseURL}/lyric?id=${songId}`;
      const response = await fetch(lyricURL);
      const data = await response.json();

      if (data.code !== 200 || !data.lrc?.lyric) {
        return null;
      }

      const rawLyrics = data.lrc.lyric;
      const lines = this.parseLyrics(rawLyrics);

      return {
        lines,
        source: "netease",
        songId
      };
    } catch (error) {
      return null;
    }
  }

  parseLyrics(rawLyrics) {
    return rawLyrics
      .split("\n")
      .map((line) => {
        const timestampMatch = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/);
        const text = line.replace(/\[\d{2}:\d{2}(?:\.\d{2,3})?\]/g, "").trim();
        
        if (!text) return null;
        
        // Filter out metadata lines
        if (/[：:]/.test(text)) return null;
        
        // Filter out technical credits
        const technicalPatterns = [
          /produced by/i, /arranged by/i, /conducted by/i,
          /recorded at/i, /engineered by/i, /mixed by/i,
          /mastered by/i, /strings arranged by/i, /vocals recorded at/i,
          /piano recorded at/i, /guitar recorded at/i, /bass recorded at/i,
          /drums recorded at/i, /music publishing/i, /ltd/i
        ];
        
        if (technicalPatterns.some(pattern => pattern.test(text))) {
          return null;
        }
        
        let timestamp = null;
        if (timestampMatch) {
          const minutes = parseInt(timestampMatch[1]);
          const seconds = parseInt(timestampMatch[2]);
          const milliseconds = timestampMatch[3] ? parseInt(timestampMatch[3]) : 0;
          timestamp = minutes * 60 + seconds + milliseconds / 1000;
        }
        
        return {
          text,
          timestamp
        };
      })
      .filter(line => line !== null);
  }
}
