// Base processor class for consistency
export class BaseProcessor {
  constructor(name, supportedSystems = []) {
    this.name = name;
    this.supportedSystems = supportedSystems;
  }

  async romanize(text, system = null, options = {}) {
    throw new Error("romanize method must be implemented by subclass");
  }

  supportsSystem(system) {
    return this.supportedSystems.includes(system);
  }

  getDefaultSystem() {
    return this.supportedSystems[0];
  }
}
