import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAnalyticsReport } from "../src/lib/analytics-report";
import { syntheticDataset } from "../src/lib/synthetic-dataset";

const outputDirectory = resolve(process.cwd(), "reports");
const outputPath = resolve(outputDirectory, "analytics-validation.json");

await mkdir(outputDirectory, { recursive: true });
await writeFile(
  outputPath,
  `${JSON.stringify(createAnalyticsReport(syntheticDataset), null, 2)}\n`,
  "utf8",
);

console.log(`Wrote deterministic analytics validation report to ${outputPath}`);
