import { NeteaseAPI } from "./netease.js";
import { SpotifyAPI } from "./spotify.js";
import { GeniusAPI } from "./genius.js";
import { LRCAPI } from "./lrclib.js";

// Music API registry
const musicAPIs = new Map();

// Initialize APIs
musicAPIs.set("lrclib", new LRCAPI());
musicAPIs.set("netease", new NeteaseAPI());
// musicAPIs.set("spotify", new SpotifyAPI());
// musicAPIs.set("genius", new GeniusAPI());

// Script to platform mapping - NetEase as primary, LRC Lib as backup
const scriptPlatformMap = {
  "zh": ["netease", "lrclib"], // Mandarin Chinese - NetEase first, then LRC Lib
  "yue": ["netease"],          // Cantonese - NetEase only
  "ja": ["lrclib"],            // Japanese - LRC Lib only
  "ko": ["lrclib"],            // Korean - LRC Lib only
  "ru": [],                    // Russian (no API available yet)
  "en": ["lrclib"]             // English - LRC Lib only
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

// New function to get all available APIs for a script (for fallback logic)
export function getAvailableAPIs(script) {
  const availablePlatforms = scriptPlatformMap[script] || [];
  const apis = [];
  
  for (const platformName of availablePlatforms) {
    if (musicAPIs.has(platformName)) {
      const api = musicAPIs.get(platformName);
      if (api.supportsLanguage(script)) {
        apis.push(api);
      }
    }
  }
  
  return apis;
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
