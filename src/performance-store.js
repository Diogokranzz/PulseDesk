import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class PerformanceStore {
  #path;
  #market;
  #lastSavedAt = 0;
  #writing = null;

  constructor(path, market) {
    this.#path = path;
    this.#market = market;
  }

  async restore() {
    try {
      const saved = JSON.parse(await readFile(this.#path, "utf8"));
      const count = this.#market.restorePerformance(saved?.points);
      this.#lastSavedAt = this.#market.exportPerformance().at(-1)?.time ?? 0;
      return count;
    } catch (error) {
      if (error.code !== "ENOENT") process.stderr.write(`${new Date().toISOString()} account history ignored: ${error.message}\n`);
      return 0;
    }
  }

  async persistIfChanged() {
    if (this.#writing) return this.#writing;
    const points = this.#market.exportPerformance();
    const latestAt = points.at(-1)?.time ?? 0;
    if (latestAt <= this.#lastSavedAt) return;
    const temporaryPath = `${this.#path}.tmp`;
    this.#writing = (async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify({ schemaVersion: 1, savedAt: Date.now(), points }), { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.#path);
      this.#lastSavedAt = latestAt;
    })().catch((error) => {
      process.stderr.write(`${new Date().toISOString()} account history write failed: ${error.message}\n`);
    }).finally(() => {
      this.#writing = null;
    });
    return this.#writing;
  }

  async clear() {
    if (this.#writing) await this.#writing;
    await rm(this.#path, { force: true });
    this.#lastSavedAt = 0;
  }

  async flush() {
    await this.persistIfChanged();
    if (this.#writing) await this.#writing;
  }
}
