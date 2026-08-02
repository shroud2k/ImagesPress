import { Toaster } from "@/components/ui/sonner";
import { HashRouter, Routes, Route } from "react-router-dom";
import { navItems } from "./nav-items";
import ErrorBoundary from "./components/ErrorBoundary";

const App = () => (
	<ErrorBoundary>
		<HashRouter>
			<Toaster />
			<Routes>
				{navItems.map(({ to, page }) => (
					<Route key={to} path={to} element={page} />
				))}
			</Routes>
		</HashRouter>
	</ErrorBoundary>
);

export default App;
