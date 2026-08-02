/**
 * Web Worker 入口 — 在独立线程中执行 Canvas 编解码（审计 2.1）
 *
 * 通信协议：
 *   主线程 → Worker: { type: 'compress', bitmap: ImageBitmap, options: {...} }
 *   主线程 → Worker: { type: 'abort' }
 *   Worker → 主线程: { type: 'progress', progress: number }
 *   Worker → 主线程: { type: 'done', result: {...} }        (blob 可转移)
 *   Worker → 主线程: { type: 'error', message: string }
 */

import { compressCore, CompressAbortError } from "./compressCore";

let aborted = false;

self.onmessage = async (e) => {
	const { type } = e.data;

	if (type === "abort") {
		aborted = true;
		return;
	}

	if (type !== "compress") {
		console.warn("[compressWorker] 未知消息类型:", type);
		return;
	}

	aborted = false;
	const { bitmap, options } = e.data;

	try {
		const result = await compressCore(bitmap, options, {
			onProgress: (p) => {
				self.postMessage({ type: "progress", progress: p });
			},
			shouldAbort: () => aborted,
		});

		// 关闭 ImageBitmap 释放内存
		if (bitmap && typeof bitmap.close === "function") {
			bitmap.close();
		}

		// 将 blob 转移回主线程（避免拷贝）
		const transferables = result.blob ? [result.blob] : [];
		self.postMessage({ type: "done", result }, transferables);
	} catch (err) {
		if (bitmap && typeof bitmap.close === "function") {
			bitmap.close();
		}

		const message =
			err instanceof CompressAbortError
				? "压缩已暂停"
				: err.message || "压缩失败";

		self.postMessage({ type: "error", message });
	}
};
