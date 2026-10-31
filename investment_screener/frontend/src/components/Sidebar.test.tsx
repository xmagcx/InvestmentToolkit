/**
 * @vitest-environment jsdom
 * Purpose: the main navigation no longer offers the Trade Log, the manual portfolio
 * maintainer is labelled "Gestión de activos", and "Oportunidades" links to the screener
 * before the Daily Brief.
 * Layer: Frontend unit. Usage: npx vitest run src/components/Sidebar.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api', async () => {
    const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
    return { ...actual, fetchSyncStatus: vi.fn().mockResolvedValue({ lastSync: null }), syncAndRefreshPortfolio: vi.fn() };
});

import Sidebar from './Sidebar';
import { PrivacyProvider } from '../context/PrivacyContext';

describe('Sidebar navigation', () => {
    afterEach(cleanup);

    it('shows "Gestión de activos" for the portfolio maintainer and hides the Trade Log', () => {
        render(
            <PrivacyProvider>
                <MemoryRouter>
                    <Sidebar />
                </MemoryRouter>
            </PrivacyProvider>
        );
        const link = screen.getByRole('link', { name: /Gestión de activos/ });
        expect(link.getAttribute('href')).toBe('/portfolio-maintainer');
        expect(screen.queryByRole('link', { name: /Trade Log/ })).toBeNull();
        expect(screen.queryByRole('link', { name: /^Portafolio$/ })).toBeNull();
    });

    it('offers "Oportunidades" before the Daily Brief', () => {
        render(
            <PrivacyProvider>
                <MemoryRouter>
                    <Sidebar />
                </MemoryRouter>
            </PrivacyProvider>
        );
        const opportunities = screen.getByRole('link', { name: /Oportunidades/ });
        expect(opportunities.getAttribute('href')).toBe('/opportunities');

        const links = screen.getAllByRole('link').map(link => link.getAttribute('href'));
        expect(links.indexOf('/opportunities')).toBeLessThan(links.indexOf('/daily-brief'));
    });
});
