/**
 * @vitest-environment jsdom
 * Purpose: the "?" tooltip (S4) opens on focus, hover and click, closes on Escape and blur, and shows the four sections.
 * Layer: Frontend integration. Usage: npx vitest run tests/analysis/HelpTip.test.tsx
 */
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HelpTip } from '../../src/components/analysis/HelpTip';

afterEach(cleanup);
const ctx = { company: 'Acme Corp', value: 23.8, price: null, fairValue: null, upside: null };
const btn = () => screen.getByRole('button', { name: '¿Qué es ROIC?' });

it('is closed by default and opens on focus', () => {
    render(<HelpTip term="roic" ctx={ctx} />);
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Qué es')).toBeNull();
    fireEvent.focus(btn());
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    for (const t of ['Qué es', 'Cómo se lee', 'En Acme Corp', 'Fuente / cálculo']) expect(screen.getByText(t)).toBeTruthy();
    expect(screen.getByRole('tooltip').textContent).toContain('23,8%');
});

it('closes on Escape', () => {
    render(<HelpTip term="roic" ctx={ctx} />);
    fireEvent.focus(btn());
    fireEvent.keyDown(btn(), { key: 'Escape' });
    expect(btn().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('tooltip')).toBeNull();
});

it('closes on blur', () => {
    render(<HelpTip term="roic" ctx={ctx} />);
    fireEvent.focus(btn());
    fireEvent.blur(btn());
    expect(btn().getAttribute('aria-expanded')).toBe('false');
});

it('opens on hover and a click pins it until clicked again', () => {
    render(<HelpTip term="roic" ctx={ctx} />);
    fireEvent.mouseEnter(btn());
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn());
    fireEvent.mouseLeave(btn());
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(btn());
    expect(btn().getAttribute('aria-expanded')).toBe('false');
});
