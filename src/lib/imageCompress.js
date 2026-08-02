// heic2any 改为动态导入，避免首屏加载 ~1MB 的库（2.3）
// 核心压缩逻辑已迁移至 compressCore.js，支持 Web Worker 执行（2.1）

import { compressCore, CompressAbortError } from "./compressCore";

// 重新导出 CompressAbortError，保持对外接口不变
export { CompressAbortError };

export const SUPPORTED_FORMATS = {
	"image/jpeg": [".jpg", ".jpeg"],
	"image/png": [".png"],
	"image/gif": [".gif"],
	"image/webp": [".webp"],
	"image/avif": [".avif"],
	"image/bmp": [".bmp"],
	"image/tiff": [".tiff", ".tif"],
	"image/heic": [".heic", ".heif"],
	// RAW/DNG 格式已从支持列表中移除：浏览器无法解码，实际处理时会抛错（4.1）
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
	if (!bytes || bytes <= 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	// 超过 GB 时直接使用 TB 单位，避免数组越界（5.1）
	if (bytes >= 1024 ** 4) return parseFloat((bytes / (1024 ** 4)).toFixed(2)) + " TB";
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

async function convertHeicToJpeg(file) {
	try {
		// 动态导入 heic2any，仅在需要处理 HEIC 时才加载（2.3）
		const { default: heic2any } = await import("heic2any");
		const blob = await heic2any({
			blob: file,
			toType: "image/jpeg",
			quality: 0.92,
		});
		// 健壮处理 heic2any 返回值：可能是 Blob 或 Blob[]（5.2）
		if (blob instanceof Blob) return blob;
		if (Array.isArray(blob) && blob.length > 0) return blob[0];
		throw new Error("HEIC 转换返回空结果");
	} catch (err) {
		throw new Error(`HEIC 格式转换失败: ${file.name}`);
	}
}

// ---- 主线程回退路径：使用 HTMLImageElement 解码 ----

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

// RAW/DNG 格式已在上层 isSupportedImage 中过滤，此处仅作防御性检查
const RAW_EXTENSIONS = [".raw", ".dng", ".cr2", ".nef", ".arw", ".orf", ".rw2"];
function warnIfRaw(file) {
	const ext = getExtension(file.name).toLowerCase();
	if (RAW_EXTENSIONS.includes(ext)) {
		console.warn(`Unexpected RAW/DNG file reached compress: ${file.name}`);
	}
}

async function fileToImage(file) {
	const ext = getExtension(file.name).toLowerCase();
	if ([".heic", ".heif"].includes(ext)) {
		return decodeImage(await convertHeicToJpeg(file));
	}
	warnIfRaw(file);
	return decodeImage(file);
}

// ---- Worker 路径：使用 ImageBitmap 解码 ----

async function fileToImageBitmap(file) {
	const ext = getExtension(file.name).toLowerCase();
	if ([".heic", ".heif"].includes(ext)) {
		const jpegBlob = await convertHeicToJpeg(file);
		return createImageBitmap(jpegBlob);
	}
	warnIfRaw(file);
	return createImageBitmap(file);
}

function hasTransparency(file) {
	return [".png", ".gif", ".webp"].includes(
		getExtension(file.name).toLowerCase(),
	);
}

// ---- Worker 支持检测 ----

const SUPPORTS_WORKER =
	typeof Worker !== "undefined" &&
	typeof createImageBitmap !== "undefined" &&
	typeof OffscreenCanvas !== "undefined";

// ---- Worker 通信 ----

/**
 * 通过 Web Worker 执行压缩。
 * ImageBitmap 被转移（transfer）到 Worker，避免拷贝大块像素数据。
 */
function compressViaWorker(bitmap, options, { onProgress, shouldAbort }) {
	return new Promise((resolve, reject) => {
		let worker;
		try {
			worker = new Worker(
				new URL("./compressWorker.js", import.meta.url),
				{ type: "module" },
			);
		} catch (e) {
			reject(new Error("Failed to create worker: " + e.message));
			return;
		}

		let aborted = false;

		worker.onmessage = (e) => {
			const { type } = e.data;
			if (type === "progress") {
				onProgress?.(e.data.progress);
				// 主线程检测到暂停时通知 Worker 中断
				if (!aborted && shouldAbort?.()) {
					aborted = true;
					worker.postMessage({ type: "abort" });
				}
			} else if (type === "done") {
				worker.terminate();
				resolve(e.data.result);
			} else if (type === "error") {
				worker.terminate();
				if (e.data.message === "压缩已暂停") {
					reject(new CompressAbortError());
				} else {
					reject(new Error(e.data.message));
				}
			}
		};

		worker.onerror = (err) => {
			worker.terminate();
			reject(new Error("Worker error: " + (err.message || "unknown")));
		};

		// 转移 ImageBitmap 所有权到 Worker
		worker.postMessage(
			{ type: "compress", bitmap, options },
			[bitmap],
		);
	});
}

// ---- 对外接口 ----

export async function compressImage(file, maxSizeMB, callbacks = {}) {
	const { onProgress, quality = 100, shouldAbort } = callbacks;
	const originalSize = file.size;
	const effectiveMaxSizeMB = maxSizeMB * (quality / 100);
	const targetBytes = effectiveMaxSizeMB * 1024 * 1024;

	// 已小于目标大小，直接跳过
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

	const usePng = hasTransparency(file);
	const mimeType = usePng ? "image/png" : "image/jpeg";
	const outputExt = usePng ? ".png" : ".jpg";

	const coreOptions = {
		targetBytes,
		usePng,
		mimeType,
		outputExt,
		fileName: file.name,
		originalSize,
	};

	// 优先使用 Web Worker 路径（2.1：根本解决主线程阻塞）
	if (SUPPORTS_WORKER) {
		let bitmap = null;
		try {
			bitmap = await fileToImageBitmap(file);
			onProgress?.(10);
			return await compressViaWorker(bitmap, coreOptions, {
				onProgress,
				shouldAbort,
			});
		} catch (err) {
			// 尝试关闭未被转移的 bitmap（已转移时 close 为空操作）
			if (bitmap) {
				try {
					bitmap.close();
				} catch (_) {
					/* 已转移，忽略 */
				}
			}
			// 暂停中断直接抛出，不走回退
			if (err instanceof CompressAbortError || err?.name === "AbortError") {
				throw err;
			}
			// 其他错误回退到主线程
			console.warn(
				"Worker 压缩失败，回退到主线程:",
				err.message || err,
			);
		}
	}

	// 回退路径：主线程执行（不支持 Worker 或 Worker 出错时）
	const img = await fileToImage(file);
	return compressCore(img, coreOptions, { onProgress, shouldAbort });
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
	};
	// 无扩展名或未知格式返回"未知"（3.2）
	return m[ext] || ext.toUpperCase() || "未知";
}
