import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "./app.js";

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
mkdirSync(dataDir, { recursive: true });
const port = Number(process.env.PORT ?? 3000);
createServer({ dataDir }).listen(port, () => {
  console.log(`Japanese song shadowing app listening on http://localhost:${port}`);
});
