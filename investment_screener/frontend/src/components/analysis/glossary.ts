/**
 * glossary.ts
 *
 * Purpose: one content map for every "?" of the Análisis page (S4). Each entry has Qué es / Cómo se lee /
 *     En <empresa> (the live value interpreted) / Fuente-cálculo. Copy from design/analysis-svi/01-svi-explicado.html.
 * Layer: Frontend / Components / Analysis. Key Functions: GLOSSARY, GlossaryCtx.
 */
import { fmtLevelEs, fmtMoneyEs, fmtNumEs, fmtPctEs } from '../../utils/analysisFormat';

export type GlossaryKey = 'signal' | 'valuation' | 'mos' | 'roic' | 'roe' | 'roa' | 'fcfy' | 'augdiv' | 'divy' | 'buyback' | 'beta' | 'de' | 'sma200' | 'levels';

export interface GlossaryCtx {
    company: string;
    /** The metric's own value in overview units (percent, or ratio for beta and Deuda/patrimonio). */
    value: number | null;
    price: number | null;
    fairValue: number | null;
    /** Distance to fair value in percent, (valor − precio) ÷ precio. */
    upside: number | null;
    currency?: string;
}

export interface GlossaryEntry {
    name: string;
    what: string;
    read: string;
    /** The value interpreted for this company; must never use a hardcoded number. */
    inCompany: (c: GlossaryCtx) => string;
    source: string;
}

const NA = (c: GlossaryCtx) => `No hay dato disponible de ${c.company} para este indicador.`;
const withValue = (fn: (c: GlossaryCtx, v: number) => string) => (c: GlossaryCtx) => (c.value == null ? NA(c) : fn(c, c.value));

export const GLOSSARY: Record<GlossaryKey, GlossaryEntry> = {
    signal: {
        name: 'Señal (Mantener, Comprar, Comprar más, Vender)',
        what: 'Resumen de qué haría nuestra regla de valoración con esta acción, según si la tienes y la distancia entre precio y valor justo.',
        read: 'Con ±15% respecto del valor justo hay señal; dentro de ese margen se mantiene. Comprar si no la tienes, Comprar más si ya la tienes, Vender (reducir) si el precio supera el valor en 15% o más, Vender (todo) si se activa una alerta de salida.',
        inCompany: (c) => c.upside == null
            ? `${c.company} no tiene valoración guardada, por lo que no hay distancia al valor ni señal.`
            : `Distancia al valor de ${c.company}: ${fmtPctEs(c.upside)} (${Math.abs(c.upside) < 15 ? 'dentro del margen de ±15%' : 'fuera del margen de ±15%'}).`,
        source: 'recommendation.py --all (umbral ACT_THRESHOLD_PCT = 15%); revisión de vigencia de 30 días y bloqueo de 30 días tras una compra o venta.',
    },
    valuation: {
        name: 'Valor justo',
        what: 'Estimación del precio por acción que justifican los flujos de caja futuros de la empresa, según nuestra proyección guardada.',
        read: 'Precio por encima del valor sugiere sobrevaloración; por debajo, infravaloración. Diferencias menores de ±15% caen dentro del margen de error habitual de un modelo.',
        inCompany: (c) => c.fairValue == null || c.price == null
            ? `${c.company} no tiene valoración guardada.`
            : `Valor justo ${fmtMoneyEs(c.fairValue, c.currency)} frente a un precio de ${fmtMoneyEs(c.price, c.currency)}.`,
        source: 'Última proyección guardada en domain_model.sqlite, la misma que usa recommendation.py.',
    },
    mos: {
        name: 'Margen de seguridad',
        what: 'Cuánto por debajo (o por encima) del valor estimado cotiza el precio: (valor − precio) ÷ valor.',
        read: 'Positivo: hay descuento. Negativo: el precio supera el valor. Muchos inversores piden un margen positivo de 20–30% para cubrir errores de estimación.',
        inCompany: withValue((c, v) => v >= 0
            ? `${fmtPctEs(v)}: el precio de ${c.company} está por debajo de su valor justo.`
            : `${fmtPctEs(v)}: el precio de ${c.company} supera su valor justo y no hay colchón de seguridad.`),
        source: 'Cálculo con el valor justo de nuestra proyección y el precio actual.',
    },
    roic: {
        name: 'ROIC',
        what: 'Rentabilidad que obtiene la empresa sobre el capital invertido por accionistas y acreedores (beneficio operativo tras impuestos ÷ capital invertido).',
        read: 'Más de 15% suele indicar ventaja competitiva; por debajo del coste de capital la empresa destruye valor.',
        inCompany: withValue((c, v) => `${fmtPctEs(v)} en ${c.company}: ${v >= 15 ? 'por encima del 15% habitual de un negocio con ventaja competitiva' : v >= 10 ? 'rentabilidad intermedia sobre el capital' : 'baja; puede no cubrir el coste de capital'}.`),
        source: 'Resumen financiero del ticker (yfinance): NOPAT ÷ capital invertido.',
    },
    roe: {
        name: 'ROE',
        what: 'Beneficio neto ÷ patrimonio de los accionistas: cuánto gana la empresa con el dinero de sus dueños.',
        read: 'Más de 15% suele ser sólido; con mucha deuda puede inflarse, por eso se compara con ROIC.',
        inCompany: withValue((c, v) => `${fmtPctEs(v)} en ${c.company}: ${v >= 15 ? 'sólido' : v >= 8 ? 'moderado' : 'bajo'}; contrástalo con ROIC y con su deuda.`),
        source: 'Resumen financiero del ticker (yfinance): beneficio neto ÷ patrimonio.',
    },
    roa: {
        name: 'ROA',
        what: 'Beneficio neto ÷ activos totales: eficiencia con la que la empresa usa todo lo que posee.',
        read: 'Más de 5% suele ser bueno, pero varía por sector: los negocios con pocos activos físicos lo tienen más alto.',
        inCompany: withValue((c, v) => `${fmtPctEs(v)} en ${c.company}: ${v >= 5 ? 'alto' : v >= 2 ? 'moderado' : 'bajo'} para el uso de sus activos.`),
        source: 'Resumen financiero del ticker (yfinance): beneficio neto ÷ activos totales.',
    },
    fcfy: {
        name: 'FCF Yield (rentabilidad por flujo de caja libre)',
        what: 'Flujo de caja libre anual ÷ capitalización bursátil: caja que genera el negocio por cada dólar que cuesta la empresa.',
        read: 'Compáralo con la tasa libre de riesgo: por encima ofrece una prima por el riesgo; por debajo, el mercado paga por crecimiento futuro.',
        inCompany: withValue((c, v) => `${fmtPctEs(v)} en ${c.company}: ${v >= 5 ? 'genera mucha caja respecto de su precio' : 'el precio descuenta crecimiento futuro'}.`),
        source: 'Resumen financiero del ticker (yfinance): FCF ÷ capitalización.',
    },
    augdiv: {
        name: 'Dividendo aumentado',
        what: 'Dividendo más recompras de acciones, como porcentaje de la capitalización: todo el capital que la empresa devuelve al accionista.',
        read: 'Más alto implica más retorno directo; no incluye el crecimiento del negocio.',
        inCompany: withValue((c, v) => `${fmtPctEs(v, 2)} en ${c.company}: ${v >= 3 ? 'retorno directo alto' : v >= 1 ? 'retorno directo moderado' : 'bajo; el valor depende del crecimiento'}.`),
        source: 'Resumen financiero del ticker: rentabilidad por dividendo + recompras netas.',
    },
    divy: {
        name: 'Rentabilidad por dividendo',
        what: 'Dividendo anual por acción ÷ precio.',
        read: 'Menos de 1% es bajo y típico de empresas que reinvierten; más de 3–4% suele ser perfil de renta y conviene revisar su sostenibilidad.',
        inCompany: withValue((c, v) => `${fmtPctEs(v, 2)} en ${c.company}: ${v < 1 ? 'bajo; el retorno proviene sobre todo del crecimiento' : v < 3 ? 'moderado' : 'perfil de renta; revisa su sostenibilidad'}.`),
        source: 'Resumen financiero del ticker: dividendos pagados ÷ capitalización.',
    },
    buyback: {
        name: 'Recompras',
        what: 'Recompras netas de acciones ÷ capitalización: parte de la empresa que se recompra cada año.',
        read: 'Positivo y sostenido reduce el número de acciones; cercano a cero significa que las recompras apenas compensan nuevas emisiones.',
        inCompany: withValue((c, v) => `${fmtPctEs(v, 2)} en ${c.company}: ${v <= 0.5 ? 'prácticamente nula en términos netos' : 'reduce el número de acciones con el tiempo'}.`),
        source: 'Resumen financiero del ticker: (recompras − emisiones) ÷ capitalización.',
    },
    beta: {
        name: 'Beta',
        what: 'Sensibilidad de la acción a los movimientos del mercado: 1 se mueve igual que el mercado.',
        read: 'Menos de 1 amortigua las caídas del mercado; más de 1,5 las amplifica. Sube el coste de capital cuando es mayor.',
        inCompany: withValue((c, v) => `Beta ${v.toFixed(2).replace('.', ',')} en ${c.company}: ${v <= 1 ? 'menos volátil que el mercado' : v <= 1.5 ? 'algo más volátil que el mercado' : 'mucho más volátil que el mercado'}.`),
        source: 'Resumen financiero del ticker (yfinance).',
    },
    de: {
        name: 'Deuda/patrimonio',
        what: 'Deuda total ÷ patrimonio de los accionistas: cuánto financia la empresa con deuda frente a capital propio.',
        read: 'Menos de 0,5 es conservador; más de 2 implica apalancamiento alto y más sensibilidad a los tipos de interés.',
        inCompany: withValue((c, v) => `${v.toFixed(2).replace('.', ',')} en ${c.company}: ${v <= 0.5 ? 'deuda baja frente a su patrimonio' : v <= 2 ? 'apalancamiento moderado' : 'apalancamiento alto'}.`),
        source: 'Balance del ticker (yfinance): deuda total ÷ patrimonio.',
    },
    sma200: {
        name: 'Media de 200 días',
        what: 'Promedio simple de los últimos 200 cierres diarios: el "precio medio" que el mercado ha pagado por la acción en cerca de un año.',
        read: 'Precio bajo la media: zona infravalorada (la acción cotiza más barata que su promedio reciente). Precio sobre la media: zona sobrevalorada. Es una referencia de precio, no un valor justo.',
        inCompany: (c) => c.value == null || c.price == null
            ? `${c.company} tiene menos de 200 sesiones de historia: aún no hay media de 200 días.`
            : `${c.company} cotiza a ${fmtMoneyEs(c.price, c.currency)} frente a una media de ${fmtMoneyEs(c.value, c.currency)}: ${fmtNumEs(Math.abs((c.price - c.value) / c.value * 100))}% ${c.price < c.value ? 'bajo' : 'sobre'} su media.`,
        source: 'value_history.py: media simple de 200 cierres diarios, calculada con toda la historia antes de recortar el rango (market_regime._sma).',
    },
    levels: {
        name: 'Soportes y resistencias',
        what: 'Precios donde la acción suele frenar: un soporte es un nivel bajo el precio donde han entrado compradores; una resistencia, uno sobre el precio donde han aparecido vendedores.',
        read: 'Bajo la media de 200 días, un soporte cercano confirma la zona de oportunidad. Sobre la media, una resistencia cercana confirma que el precio está exigente. Si no hay niveles cerca, la señal queda sin confirmar.',
        inCompany: (c) => c.value == null || c.price == null
            ? `No hay un nivel de confirmación cercano para ${c.company}.`
            : `Nivel más próximo de ${c.company}: ${fmtLevelEs(c.value)}, a ${fmtNumEs(Math.abs((c.value - c.price) / c.price * 100))}% ${c.value < c.price ? 'bajo' : 'sobre'} el precio actual.`,
        source: 'chart_levels.py: retrocesos de Fibonacci del último tramo alcista (swing), zonas de volumen del último año y medias exponenciales (EMA 50 y 200).',
    },
};
