import fetch from "node-fetch";
import { BaseMusicAPI } from "./base.js";

export class LRCAPI extends BaseMusicAPI {
  constructor() {
    super("LRCAPI", ["zh", "en", "ja", "ko"]); // Supports multiple languages
    this.baseURL = "https://lrclib.net/api";
  }

  async searchSong(artist, title) {
    try {
      const searchQuery = `${artist} ${title}`;
      const searchURL = `${this.baseURL}/search?q=${encodeURIComponent(searchQuery)}`;
      
      console.log(`LRC Lib searching: ${searchURL}`);
      const response = await fetch(searchURL);
      
      if (!response.ok) {
        console.log(`LRC Lib search failed: ${response.status} ${response.statusText}`);
        return null;
      }
      
      const data = await response.json();
      console.log(`LRC Lib search results: ${data ? data.length : 0} songs found`);

      if (!data || !data.length) {
        return null;
      }

      // Find the best match (prefer Chinese songs for Chinese queries)
      const bestMatch = this.findBestMatch(data, artist, title);
      
      if (!bestMatch) {
        console.log("LRC Lib: No good match found");
        return null;
      }

      console.log(`LRC Lib found: ${bestMatch.artistName} - ${bestMatch.name}`);

      // Store the lyrics data for later use
      this.lastSearchResults = data;
      this.lastBestMatch = bestMatch;

      return {
        id: bestMatch.id,
        title: bestMatch.name,
        artist: bestMatch.artistName,
        album: bestMatch.albumName,
        duration: bestMatch.duration,
        source: "lrclib"
      };
    } catch (error) {
      console.error("LRC Lib search error:", error);
      return null;
    }
  }

  async getLyrics(songId) {
    try {
      // Use the stored search results if available
      if (this.lastBestMatch && this.lastBestMatch.id === songId) {
        console.log("Using cached lyrics from search results");
        
        if (this.lastBestMatch.syncedLyrics) {
          const lines = this.parseSyncedLyrics(this.lastBestMatch.syncedLyrics);
          return {
            lines,
            source: "lrclib",
            songId
          };
        } else if (this.lastBestMatch.plainLyrics) {
          const lines = this.parsePlainLyrics(this.lastBestMatch.plainLyrics);
          return {
            lines,
            source: "lrclib",
            songId
          };
        }
      }

      // Fallback to API call if needed
      const lyricURL = `${this.baseURL}/lyrics/${songId}`;
      const response = await fetch(lyricURL);
      
      if (!response.ok) {
        return null;
      }
      
      const data = await response.json();

      if (!data || !data.lines || !data.lines.length) {
        return null;
      }

      const lines = this.parseLyrics(data.lines);

      return {
        lines,
        source: "lrclib",
        songId
      };
    } catch (error) {
      console.error("LRC Lib lyrics error:", error);
      return null;
    }
  }

  findBestMatch(songs, artist, title) {
    // Simple matching logic - can be improved
    const searchTerms = `${artist} ${title}`.toLowerCase();
    
    console.log(`Looking for: "${artist} ${title}"`);
    console.log(`Available songs: ${songs.length}`);
    
    // First, try exact matches
    for (const song of songs) {
      const songText = `${song.artistName} ${song.name}`.toLowerCase();
      console.log(`Checking: "${song.artistName} ${song.name}"`);
      
      if (songText.includes(searchTerms) || searchTerms.includes(songText)) {
        console.log(`Exact match found: ${song.artistName} - ${song.name}`);
        return song;
      }
    }
    
    // Then try partial matches
    for (const song of songs) {
      const artistMatch = song.artistName.toLowerCase().includes(artist.toLowerCase());
      const titleMatch = song.name.toLowerCase().includes(title.toLowerCase());
      
      if (artistMatch && titleMatch) {
        console.log(`Partial match found: ${song.artistName} - ${song.name}`);
        return song;
      }
    }
    
    // Return first result if no good match found
    console.log(`No match found, returning first result: ${songs[0]?.artistName} - ${songs[0]?.name}`);
    return songs[0] || null;
  }

  parseLyrics(rawLines) {
    return rawLines
      .map((line) => {
        if (!line.words || !line.words.trim()) {
          return null;
        }
        
        return {
          text: line.words.trim(),
          timestamp: line.startTime / 1000 // Convert from milliseconds to seconds
        };
      })
      .filter(line => line !== null);
  }

  parseSyncedLyrics(syncedLyrics) {
    if (!syncedLyrics) return [];
    
    return syncedLyrics
      .split('\n')
      .map((line) => {
        const timestampMatch = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\]/);
        const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/, '').trim();
        
        if (!text) return null;
        
        let timestamp = null;
        if (timestampMatch) {
          const minutes = parseInt(timestampMatch[1]);
          const seconds = parseInt(timestampMatch[2]);
          const milliseconds = parseInt(timestampMatch[3]);
          timestamp = minutes * 60 + seconds + milliseconds / 1000;
        }
        
        return {
          text,
          timestamp
        };
      })
      .filter(line => line !== null);
  }

  parsePlainLyrics(plainLyrics) {
    if (!plainLyrics) return [];
    
    return plainLyrics
      .split('\n')
      .map((line) => {
        const text = line.trim();
        if (!text) return null;
        
        return {
          text,
          timestamp: null
        };
      })
      .filter(line => line !== null);
  }
}
