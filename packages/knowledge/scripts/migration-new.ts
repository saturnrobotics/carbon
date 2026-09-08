import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { now } from "@internationalized/date";

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]{0,80}$/.test(name)) {
  throw new Error("Provide a lowercase migration name");
}
const time = now("UTC");
const timestamp = [time.year, time.month, time.day, time.hour, time.minute, time.second]
  .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"))
  .join("");
const directory = resolve(import.meta.dirname, "../migrations");
await mkdir(directory, { recursive: true });
const file = resolve(directory, `${timestamp}_${name}.sql`);
await writeFile(file, "-- Independently applied knowledge migration.\n", { flag: "wx" });
console.log(file);
