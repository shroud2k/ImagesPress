import { Toaster } from "@/components/ui/sonner";
import Index from "./pages/Index.jsx";
import ErrorBoundary from "./components/ErrorBoundary";

// 6.3: 单页面应用仅有一个路由，移除 react-router-dom 依赖
const App = () => (
	<ErrorBoundary>
		<Toaster />
		<Index />
	</ErrorBoundary>
);

export default App;
