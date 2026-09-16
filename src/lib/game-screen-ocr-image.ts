/** Browser and Node compatible image data used by the OCR preprocessor. */
export interface OcrImageData {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

/**
 * Makes the game UI's fine moire pattern harmless to OCR without relying on
 * CanvasRenderingContext2D.filter, so Node and the browser make identical pixels.
 */
export function preprocessGameScreenImage(source: OcrImageData, threshold: number, sigma = 1.2): OcrImageData {
	const { width, height } = source;
	if (width < 1 || height < 1 || source.data.length !== width * height * 4) {
		throw new Error("Invalid OCR image data");
	}
	const gray = new Float32Array(width * height);
	for (let pixel = 0, offset = 0; pixel < gray.length; pixel++, offset += 4) {
		gray[pixel] = source.data[offset] * 0.299 + source.data[offset + 1] * 0.587 + source.data[offset + 2] * 0.114;
	}
	const radius = Math.max(1, Math.ceil(sigma * 3));
	const kernel = new Float32Array(radius * 2 + 1);
	let total = 0;
	for (let offset = -radius; offset <= radius; offset++) {
		const value = Math.exp(-(offset * offset) / (2 * sigma * sigma));
		kernel[offset + radius] = value;
		total += value;
	}
	for (let index = 0; index < kernel.length; index++) {
		kernel[index] /= total;
	}
	const horizontal = new Float32Array(gray.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let value = 0;
			for (let offset = -radius; offset <= radius; offset++) {
				value += gray[y * width + Math.min(width - 1, Math.max(0, x + offset))] * kernel[offset + radius];
			}
			horizontal[y * width + x] = value;
		}
	}
	const data = new Uint8ClampedArray(source.data.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let value = 0;
			for (let offset = -radius; offset <= radius; offset++) {
				value += horizontal[Math.min(height - 1, Math.max(0, y + offset)) * width + x] * kernel[offset + radius];
			}
			// 平滑化後の閾値で文字と背景を二値化し、OCRが読みやすい画像にする。
			const color = value >= threshold ? 0 : 255;
			const index = (y * width + x) * 4;
			data[index] = data[index + 1] = data[index + 2] = color;
			data[index + 3] = 255;
		}
	}
	return { width, height, data };
}
