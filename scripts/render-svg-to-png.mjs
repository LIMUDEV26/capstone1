import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

/**
 * SVG to PNG Converter Script
 * 
 * Supports two modes:
 * 1. Single-file mode (backward compatible):
 *    node render-svg-to-png.mjs <input.svg> <output.png>
 * 
 * 2. Batch mode:
 *    node render-svg-to-png.mjs --batch <batch.json>
 *    where batch.json contains: [{"input": "/path/to/input.svg", "output": "/path/to/output.png"}, ...]
 * 
 * Batch mode outputs JSON to stdout: {"results": [{"input": "...", "output": "...", "success": true}, ...]}
 */

async function renderSvgToPng(inputPath, outputPath) {
  const svgBuffer = await fs.readFile(inputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await sharp(svgBuffer, { density: 96 })
    .png({
      compressionLevel: 3, // Faster compression (0-9, lower is faster)
      quality: 95, // Slightly reduced quality for faster encoding (still excellent)
      palette: false,
    })
    .toFile(outputPath);
}

async function processBatch(batchFilePath) {
  const batchContent = await fs.readFile(batchFilePath, "utf-8");
  const batch = JSON.parse(batchContent);

  if (!Array.isArray(batch)) {
    throw new Error("Batch file must contain a JSON array");
  }

  const startTime = Date.now();
  const results = await Promise.all(
    batch.map(async (item, index) => {
      const inputPath = item.input;
      const outputPath = item.output;
      const itemStart = Date.now();

      try {
        await renderSvgToPng(inputPath, outputPath);
        const duration = Date.now() - itemStart;
        console.error(`[Sharp Perf] Certificate ${index + 1}/${batch.length}: ${duration}ms`);
        return { input: inputPath, output: outputPath, success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { input: inputPath, output: outputPath, success: false, error: message };
      }
    })
  );

  const totalDuration = Date.now() - startTime;
  console.error(`[Sharp Perf] Batch rendering complete: ${totalDuration}ms for ${batch.length} certificates`);

  return { results };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    throw new Error("Usage: node scripts/render-svg-to-png.mjs <input.svg> <output.png>\n       node scripts/render-svg-to-png.mjs --batch <batch.json>");
  }

  // Check for batch mode
  if (args[0] === "--batch") {
    if (!args[1]) {
      throw new Error("Batch mode requires a JSON file path argument");
    }
    const batchFilePath = args[1];
    const result = await processBatch(batchFilePath);
    console.log(JSON.stringify(result));
    return;
  }

  // Single-file mode (backward compatible)
  const [inputPath, outputPath] = args;

  if (!inputPath || !outputPath) {
    throw new Error("Usage: node scripts/render-svg-to-png.mjs <input.svg> <output.png>");
  }

  await renderSvgToPng(inputPath, outputPath);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
