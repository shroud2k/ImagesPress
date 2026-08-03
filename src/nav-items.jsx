import { HomeIcon } from "lucide-react";
import Index from "./pages/Index.jsx";

// 8.3: 传递组件引用而非 JSX 元素，避免不必要的提前实例化
export const navItems = [
	{
		title: "Home",
		to: "/",
		icon: HomeIcon,
		page: Index,
	},
];
