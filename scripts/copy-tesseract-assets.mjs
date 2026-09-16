import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const destination = resolve("public/tesseract");
await mkdir(destination, { recursive: true });
await Promise.all([
	cp(resolve("node_modules/tesseract.js/dist/worker.min.js"), resolve(destination, "worker.min.js")),
	cp(resolve("node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js"), resolve(destination, "tesseract-core-lstm.wasm.js")),
]);
