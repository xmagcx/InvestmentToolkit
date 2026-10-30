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
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import MainLayout from './layouts/MainLayout';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Heatmap from './pages/Heatmap';
import PortfolioSummaryPage from './pages/PortfolioSummaryPage';

import { HelpModalProvider } from './components/HelpModal';
import { PrivacyProvider } from './context/PrivacyContext';

import PortfolioPage from './pages/PortfolioPage';
import TradeLog from './pages/TradeLog';
import ThesesPage from './pages/ThesesPage';
import DailyBriefPage from './pages/DailyBriefPage';
import SourcesPage from './pages/SourcesPage';
import RecentBuysPage from './pages/RecentBuysPage';

function App() {
  return (
    <PrivacyProvider>
      <HelpModalProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<MainLayout />}>
              <Route index element={<Heatmap />} />
              <Route path="portfolio-summary" element={<PortfolioSummaryPage />} />
              <Route path="portfolio" element={<PortfolioPage />} />
              {/* The old Portfolio Table and Portfolio Advisor pages are one page now. */}
              <Route path="portfolio-table" element={<Navigate to="/portfolio" replace />} />
              <Route path="screener" element={<Navigate to="/portfolio" replace />} />
              <Route path="analysis" element={<Dashboard />} />
              <Route path="trade-log" element={<TradeLog />} />
              <Route path="theses" element={<ThesesPage />} />
              <Route path="daily-brief" element={<DailyBriefPage />} />
              <Route path="sources" element={<SourcesPage />} />
              <Route path="recent-buys" element={<RecentBuysPage />} />
              <Route path="settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </HelpModalProvider>
    </PrivacyProvider>
  );
}

export default App;
