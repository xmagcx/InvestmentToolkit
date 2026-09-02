/**
 * App.tsx (React Root Component)
 * =====================================
 *
 * Purpose:
 *     The main application entry point defining the routing structure and global context providers.
 *
 * Layer: Frontend / Core
 *
 * Usage Examples:
 *     ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
 *
 * Key Functions:
 *     - App() - Configures the React Router hierarchy and wraps the application in essential providers (HelpModalProvider)
 */
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Heatmap from './pages/Heatmap';
import PortfolioTablePage from './pages/PortfolioTablePage';
import PortfolioSummaryPage from './pages/PortfolioSummaryPage';

import { HelpModalProvider } from './components/HelpModal';
import { PrivacyProvider } from './context/PrivacyContext';

import ScreenerPage from './pages/ScreenerPage';
import TradeLog from './pages/TradeLog';
import ThirteenFPage from './pages/ThirteenFPage';
import ThesesPage from './pages/ThesesPage';
import DailyBriefPage from './pages/DailyBriefPage';
import UniversePage from './pages/UniversePage';
import PortfolioMaintainerPage from './pages/PortfolioMaintainerPage';

function App() {
  return (
    <PrivacyProvider>
      <HelpModalProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<MainLayout />}>
              <Route index element={<Heatmap />} />
              <Route path="portfolio-summary" element={<PortfolioSummaryPage />} />
              <Route path="portfolio-table" element={<PortfolioTablePage />} />
              <Route path="screener" element={<ScreenerPage />} />
              <Route path="analysis" element={<Dashboard />} />
              <Route path="trade-log" element={<TradeLog />} />
              <Route path="theses" element={<ThesesPage />} />
              <Route path="13f" element={<ThirteenFPage />} />
              <Route path="daily-brief" element={<DailyBriefPage />} />
              <Route path="universe" element={<UniversePage />} />
              <Route path="portfolio-maintainer" element={<PortfolioMaintainerPage />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </HelpModalProvider>
    </PrivacyProvider>
  );
}

export default App;
