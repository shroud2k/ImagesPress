import { fileURLToPath, URL } from "url";
import { defineConfig } from "vite";
import { resolve } from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
	server: { host: "::", port: "8080" },
	plugins: [react()],
	build: {
		// heic2any 通过动态导入已实现代码分割（不影响首屏），
		// 其单独 chunk 体积大是预期行为，提高阈值以消除构建警告
		chunkSizeWarningLimit: 1500,
	},
	resolve: {
		alias: [
			{
				find: "@",
				replacement: fileURLToPath(new URL("./src", import.meta.url)),
			},
		],
	},
});
