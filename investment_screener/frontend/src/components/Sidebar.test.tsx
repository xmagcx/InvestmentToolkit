/**
 * @vitest-environment jsdom
 * Purpose: the main navigation no longer offers the Trade Log, and the manual portfolio
 * maintainer is labelled "Gestión de activos".
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
});
