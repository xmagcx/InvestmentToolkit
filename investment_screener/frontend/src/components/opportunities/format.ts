/**
 * format.ts (TypeScript helpers)
 * =====================================
 *
 * Purpose:
 *     Shared display helpers of the Oportunidades screener: Spanish (es-CL) number formatting
 *     (comma decimals, dot thousands) and the plain-language name of each question group,
 *     exactly as the artboard design/oportunidades/01-embudo.html renders them.
 *
 * Layer: Frontend / UI / Helpers
 *
 * Usage Examples:
 *     num(16.2, 1)  // "16,2"
 *     pct(30.2, 0)  // "30 %"
 *     int(1645)     // "1.645"
 */
import type { GroupId } from '../../services/opportunities';

/** Fixed decimals with a comma separator; null stays null so callers can render "n/d". */
export function num(value: number | null | undefined, decimals = 1): string | null {
    if (value === null || value === undefined || Number.isNaN(value)) return null;
    return value.toFixed(decimals).replace('.', ',');
}

export function pct(value: number | null | undefined, decimals = 1): string | null {
    const text = num(value, decimals);
    return text === null ? null : `${text} %`;
}

export function int(value: number): string {
    return value.toLocaleString('es-CL');
}

/** The five star-bearing questions, in the order the funnel asks them. */
export const GROUP_ORDER: GroupId[] = ['calidad', 'precio', 'caida', 'giro', 'expertos'];

export const GROUP_NAMES: Record<GroupId, string> = {
    calidad: '¿Es un buen negocio?',
    precio: '¿Está a buen precio?',
    caida: '¿Cayó por causas externas?',
    giro: '¿Ya empezó a recuperarse?',
    expertos: '¿Lo compran los expertos?',
};
