import heic2any from "heic2any";

export const SUPPORTED_FORMATS = {
	"image/jpeg": [".jpg", ".jpeg"],
	"image/png": [".png"],
	"image/gif": [".gif"],
	"image/webp": [".webp"],
	"image/avif": [".avif"],
	"image/bmp": [".bmp"],
	"image/tiff": [".tiff", ".tif"],
	"image/heic": [".heic", ".heif"],
	"image/x-adobe-dng": [".dng"],
	"image/x-raw": [".raw", ".cr2", ".nef", ".arw", ".orf", ".rw2"],
};

export const ALL_EXTENSIONS = Object.values(SUPPORTED_FORMATS).flat();

export function isSupportedImage(file) {
	const ext = getExtension(file.name).toLowerCase();
	return ALL_EXTENSIONS.includes(ext) || isImageMimeType(file.type);
}

function isImageMimeType(mime) {
	if (!mime) return false;
	return mime.startsWith("image/");
}

function getExtension(filename) {
	const lastDot = filename.lastIndexOf(".");
	return lastDot >= 0 ? filename.slice(lastDot) : "";
}

export function formatFileSize(bytes) {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function convertHeicToJpeg(file) {
	try {
		const blob = await heic2any({
			blob: file,
			toType: "image/jpeg",
			quality: 0.92,
		});
		return blob instanceof Blob ? blob : blob[0];
	} catch (err) {
		throw new Error(`HEIC 格式转换失败: ${file.name}`);
	}
}

function decodeImage(file) {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error(`无法解码: ${file.name}`));
		};
		img.src = url;
	});
}

function canvasToBlob(canvas, mimeType, quality) {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error("Canvas 导出失败"))),
			mimeType,
			quality,
		);
	});
}

async function fileToImage(file) {
	const ext = getExtension(file.name).toLowerCase();
	if ([".heic", ".heif"].includes(ext)) {
		return decodeImage(await convertHeicToJpeg(file));
	}
	if ([".raw", ".dng", ".cr2", ".nef", ".arw", ".orf", ".rw2"].includes(ext)) {
		throw new Error(`RAW/DNG 格式 (${ext}) 需要专业软件处理`);
	}
	return decodeImage(file);
}

function hasTransparency(file) {
	return [".png", ".gif", ".webp"].includes(
		getExtension(file.name).toLowerCase(),
	);
}

export class CompressAbortError extends Error {
	constructor() {
		super("压缩已暂停");
		this.name = "AbortError";
	}
}

export async function compressImage(file, maxSizeMB, callbacks = {}) {
	const { onProgress, quality = 100, shouldAbort } = callbacks;
	const checkAbort = () => {
		if (shouldAbort?.()) throw new CompressAbortError();
	};
	const originalSize = file.size;
	const effectiveMaxSizeMB = maxSizeMB * (quality / 100);
	const targetBytes = effectiveMaxSizeMB * 1024 * 1024;

	if (originalSize <= targetBytes) {
		return {
			blob: file,
			originalSize,
			compressedSize: originalSize,
			fileName: file.name,
			skipped: true,
		};
	}

	onProgress?.(5);
	const img = await fileToImage(file);
	const { naturalWidth: w, naturalHeight: h } = img;
	onProgress?.(15);

	const usePng = hasTransparency(file);
	const mimeType = usePng ? "image/png" : "image/jpeg";
	const outputExt = usePng ? ".png" : ".jpg";

	const canvas = document.createElement("canvas");
	const ctx = canvas.getContext("2d");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";

	const encodeAt = (scale, q) => {
		const cw = Math.max(1, Math.round(w * scale));
		const ch = Math.max(1, Math.round(h * scale));
		canvas.width = cw;
		canvas.height = ch;
		ctx.drawImage(img, 0, 0, cw, ch);
		return canvasToBlob(canvas, mimeType, usePng ? undefined : q);
	};

	// 固定质量，二分缩放比例（缩小），输出不超过 target 的最大文件
	const searchByScale = async (q, iters, progressBase, progressSpan) => {
		let lo = 0.05,
			hi = 1.0,
			best = null,
			bestScale = 0;
		for (let i = 0; i < iters; i++) {
			checkAbort();
			const mid = (lo + hi) / 2;
			const blob = await encodeAt(mid, q);
			onProgress?.(progressBase + Math.round(((i + 1) / iters) * progressSpan));
			if (blob.size <= targetBytes) {
				best = blob;
				bestScale = mid;
				lo = mid;
			} else {
				hi = mid;
			}
		}
		// 局部上探精炼：大小-缩放曲线非单调（缩放会平滑噪点），
		// 二分结果可能偏小，在 (bestScale, hi) 区间内继续上探用满预算
		if (best) {
			for (const f of [0.5, 0.75]) {
				checkAbort();
				const s = bestScale + (hi - bestScale) * f;
				if (s <= bestScale || s >= 1.0) continue;
				const blob = await encodeAt(s, q);
				if (blob.size <= targetBytes && blob.size > best.size) {
					best = blob;
					bestScale = s;
				}
			}
		}
		return best;
	};

	// 固定质量，二分放大比例（>1），用满目标大小预算
	const searchUpscale = async (q, maxScale, iters, progressBase, progressSpan) => {
		let lo = 1.0,
			hi = maxScale,
			best = null,
			bestScale = 0;
		for (let i = 0; i < iters; i++) {
			checkAbort();
			const mid = (lo + hi) / 2;
			const blob = await encodeAt(mid, q);
			onProgress?.(progressBase + Math.round(((i + 1) / iters) * progressSpan));
			if (blob.size <= targetBytes) {
				best = blob;
				bestScale = mid;
				lo = mid;
			} else {
				hi = mid;
			}
		}
		if (best) {
			for (const f of [0.5, 0.75]) {
				checkAbort();
				const s = bestScale + (hi - bestScale) * f;
				if (s <= bestScale || s > maxScale) continue;
				const blob = await encodeAt(s, q);
				if (blob.size <= targetBytes && blob.size > best.size) {
					best = blob;
					bestScale = s;
				}
			}
		}
		return best;
	};

	// 固定像素尺寸编码（允许单维 1:1 的非等比输出）
	const encodeDims = (cw, ch, q) => {
		canvas.width = Math.max(1, cw);
		canvas.height = Math.max(1, ch);
		ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
		return canvasToBlob(canvas, mimeType, usePng ? undefined : q);
	};

	// 满幅边缘探测：缩放搜索结果仍明显小于目标时，定向尝试“单维 1:1 +
	// 另一维微缩几像素”的候选尺寸。重采样只发生在单一方向时噪点保留最多，
	// 文件大小在满幅边缘形成尖顶（实测：4671x7007→28.9MB，4672x7007→31.3MB，
	// 4672x7008→32.9MB），这些候选是保留原始细节最多且不超标的选择
	const edgeRefine = async (q, current) => {
		if (current && current.size >= targetBytes * 0.98) return current;
		let best = current;
		const seen = new Set();
		const candidates = [];
		for (const k of [1, 2, 3, 5, 8, 13]) {
			candidates.push([w, h - k], [w - k, h]);
		}
		// 按像素总数从大到小排序，最接近满幅的优先
		candidates.sort((a, b) => b[0] * b[1] - a[0] * a[1]);
		const MAX_PROBES = 6; // 限制探测次数，避免尖顶全超标时耗时过长
		let probes = 0;
		for (const [cw, ch] of candidates) {
			if (probes >= MAX_PROBES) break;
			if (cw < 1 || ch < 1 || (cw === w && ch === h)) continue;
			const key = cw + "x" + ch;
			if (seen.has(key)) continue;
			seen.add(key);
			checkAbort();
			probes++;
			const blob = await encodeDims(cw, ch, q);
			if (blob.size <= targetBytes) {
				if (!best || blob.size > best.size) best = blob;
				break; // 最接近满幅的合规候选即尖顶最优，停止探测
			}
		}
		return best;
	};

	let bestBlob = null;

	if (usePng) {
		// PNG 无质量参数：先试原尺寸，再二分缩放逼近目标大小
		checkAbort();
		const full = await encodeAt(1);
		onProgress?.(35);
		if (full.size <= targetBytes) {
			bestBlob = full;
		} else {
			bestBlob = await searchByScale(undefined, 10, 35, 55);
			bestBlob = await edgeRefine(undefined, bestBlob);
		}
	} else {
		// JPEG：先在原分辨率下二分质量
		let lo = 0.5,
			hi = 1.0,
			bestFit = null, // 不超过 target 的最高质量结果
			bestFitQ = null,
			firstMiss = null, // 超过 target 的最低质量结果（档位跳变点）
			firstMissQ = null;
		const Q_ITERS = 8;
		for (let i = 0; i < Q_ITERS; i++) {
			checkAbort();
			const mid = (lo + hi) / 2;
			const blob = await encodeAt(1, mid);
			onProgress?.(15 + Math.round(((i + 1) / Q_ITERS) * 45));
			if (blob.size <= targetBytes) {
				if (bestFitQ === null || mid > bestFitQ) {
					bestFit = blob;
					bestFitQ = mid;
				}
				lo = mid;
			} else {
				if (firstMissQ === null || mid < firstMissQ) {
					firstMiss = blob;
					firstMissQ = mid;
				}
				hi = mid;
			}
		}

		if (!bestFit) {
			// 原分辨率下最低质量也超标，降低分辨率逼近目标
			bestBlob = await searchByScale(0.85, 10, 60, 30);
		} else if (!firstMiss) {
			// 所有质量档（含 q≈1.0）全分辨率都小于目标（原图编码效率低，
			// 如相机直出 JPEG）：质量已到顶，通过适度放大分辨率用满目标
			// 大小预算（上限 1.3x）
			const upscaled = await searchUpscale(1.0, 1.3, 8, 60, 30);
			bestBlob = upscaled || bestFit;
		} else if (bestFit.size >= targetBytes * 0.9) {
			// 已足够接近目标大小
			bestBlob = bestFit;
		} else {
			// 编码器质量档位发生跳变（如 4:2:0 → 4:4:4 色度抽样切换）：
			// 全分辨率下合规档远小于目标、超标档又太大。
			// 改用超标档的高画质 + 轻微缩小分辨率，让输出尽量接近目标大小。
			const scaled = await searchByScale(firstMissQ, 8, 60, 30);
			bestBlob = scaled && scaled.size > bestFit.size ? scaled : bestFit;
			bestBlob = await edgeRefine(firstMissQ, bestBlob);
		}
	}

	if (!bestBlob) {
		bestBlob = await encodeAt(0.05, usePng ? undefined : 0.1);
	}

	onProgress?.(95);
	const origExt = getExtension(file.name).toLowerCase();
	let outputName = file.name;
	if (origExt !== outputExt) {
		outputName = file.name.replace(new RegExp(`\\${origExt}$`, "i"), outputExt);
	}
	onProgress?.(100);

	return {
		blob: bestBlob,
		originalSize,
		compressedSize: bestBlob.size,
		fileName: outputName,
		skipped: false,
	};
}

export function getPreviewUrl(file, maxPreviewSizeMB = 50) {
	if (file.size > maxPreviewSizeMB * 1024 * 1024) return null;
	const ext = getExtension(file.name).toLowerCase();
	const previewable = [
		".jpg",
		".jpeg",
		".png",
		".gif",
		".webp",
		".bmp",
		".avif",
		".svg",
	];
	if (previewable.includes(ext) || file.type?.startsWith("image/"))
		return URL.createObjectURL(file);
	return null;
}

export function getFormatLabel(fileName) {
	const ext = getExtension(fileName).toLowerCase().replace(".", "");
	const m = {
		jpg: "JPG",
		jpeg: "JPEG",
		png: "PNG",
		gif: "GIF",
		webp: "WebP",
		avif: "AVIF",
		bmp: "BMP",
		tiff: "TIFF",
		tif: "TIF",
		heic: "HEIC",
		heif: "HEIF",
		raw: "RAW",
		dng: "DNG",
		cr2: "CR2",
		nef: "NEF",
		arw: "ARW",
		orf: "ORF",
		rw2: "RW2",
	};
	return m[ext] || ext.toUpperCase();
}
