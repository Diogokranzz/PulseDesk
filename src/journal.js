import { appendFile, mkdir, readFile, rename, rm, truncate, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export class Journal {
  #path;
  #pending = Promise.resolve();

  constructor(path) {
    this.#path = path;
  }

  async open() {
    await mkdir(dirname(this.#path), { recursive: true });
    try {
      const contents = await readFile(this.#path, "utf8");
      const completeLength = contents.endsWith("\n") ? contents.length : contents.lastIndexOf("\n") + 1;
      if (completeLength < contents.length) await truncate(this.#path, Buffer.byteLength(contents.slice(0, completeLength)));
      return contents.slice(0, completeLength).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  append(event) {
    const line = `${JSON.stringify(event)}\n`;
    const operation = this.#pending.then(() => appendFile(this.#path, line, "utf8"));
    this.#pending = operation.catch(() => {});
    return operation;
  }

  replace(event) {
    const line = `${JSON.stringify(event)}\n`;
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    const operation = this.#pending.then(async () => {
      try {
        await writeFile(temporaryPath, line, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporaryPath, this.#path);
      } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }

  async drain() {
    await this.#pending;
  }
}
