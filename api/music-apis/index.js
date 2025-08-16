import { NeteaseAPI } from "./netease.js";
import { SpotifyAPI } from "./spotify.js";
import { GeniusAPI } from "./genius.js";

// Music API registry
const musicAPIs = new Map();

// Initialize APIs
musicAPIs.set("netease", new NeteaseAPI());
// musicAPIs.set("spotify", new SpotifyAPI());
// musicAPIs.set("genius", new GeniusAPI());

// Script to platform mapping for MVP
const scriptPlatformMap = {
  "zh": ["netease"], // Mandarin Chinese
  "yue": ["netease"],           // Cantonese
  "ja": [],                     // Japanese (no API available yet)
  "ko": [],                     // Korean (no API available yet)
  "ru": [],                     // Russian (no API available yet)
  "en": []                      // English (no API available yet)
};

export function getMusicAPI(script, platform = null) {
  // If platform is specified, try to get that specific API
  if (platform && musicAPIs.has(platform)) {
    const api = musicAPIs.get(platform);
    if (api.supportsLanguage(script)) {
      return api;
    }
  }
  
  // Otherwise, get the best available API for the script
  const availablePlatforms = scriptPlatformMap[script] || [];
  for (const platformName of availablePlatforms) {
    if (musicAPIs.has(platformName)) {
      const api = musicAPIs.get(platformName);
      if (api.supportsLanguage(script)) {
        return api;
      }
    }
  }
  
  return null;
}

export function registerMusicAPI(platformName, api) {
  musicAPIs.set(platformName, api);
}

export function getSupportedLanguages() {
  return Object.keys(scriptPlatformMap);
}

export function getSupportedPlatforms() {
  return Array.from(musicAPIs.keys());
}
