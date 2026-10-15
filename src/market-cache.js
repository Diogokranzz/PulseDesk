import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class MarketCache {
  #path;
  #market;
  #lastSavedSequence = -1;
  #writing = null;

  constructor(path, market) {
    this.#path = path;
    this.#market = market;
  }

  async restore() {
    try {
      const source = await readFile(this.#path, "utf8");
      const restored = this.#market.restoreCache(JSON.parse(source));
      this.#lastSavedSequence = this.#market.sequence;
      return restored;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      process.stderr.write(`${new Date().toISOString()} market cache ignored: ${error.message}\n`);
      return 0;
    }
  }

  async persistIfChanged() {
    if (this.#writing) return this.#writing;
    if (this.#market.sequence === this.#lastSavedSequence) return;
    const sequence = this.#market.sequence;
    const temporaryPath = `${this.#path}.tmp`;
    this.#writing = (async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify(this.#market.exportCache()), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#path);
      this.#lastSavedSequence = sequence;
    })().catch((error) => {
      process.stderr.write(`${new Date().toISOString()} market cache write failed: ${error.message}\n`);
    }).finally(() => {
      this.#writing = null;
    });
    return this.#writing;
  }

  async flush() {
    await this.persistIfChanged();
    if (this.#writing) await this.#writing;
    if (this.#market.sequence !== this.#lastSavedSequence) {
      await this.persistIfChanged();
      if (this.#writing) await this.#writing;
    }
  }
}
