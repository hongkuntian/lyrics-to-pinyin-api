// Base music API class for consistency
export class BaseMusicAPI {
  constructor(name, supportedLanguages = []) {
    this.name = name;
    this.supportedLanguages = supportedLanguages;
  }

  async searchSong(artist, title) {
    throw new Error("searchSong method must be implemented by subclass");
  }

  async getLyrics(songId) {
    throw new Error("getLyrics method must be implemented by subclass");
  }

  supportsLanguage(language) {
    return this.supportedLanguages.includes(language);
  }

  getSupportedLanguages() {
    return this.supportedLanguages;
  }
}
