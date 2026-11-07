import { describe, it, expect } from 'vitest';
import { zoneRuns, valueReading, levelsInRange } from '../../src/utils/analysisFormat';
const P = (price: number, sma200: number | null) => ({ date: 'd', price, fair_value: null, sma200 });
describe('zoneRuns probes', () => {
  it('empty and single point', () => {
    expect(zoneRuns([])).toEqual([]);
    expect(zoneRuns([P(10, 9)])).toEqual([]);
  });
  it('price equal to sma at a point between two sides', () => {
    const r = zoneRuns([P(10, 10), P(12, 10), P(8, 10)]);
    console.log('EQ-MID', JSON.stringify(r));
    expect(r.every((x) => x.price.length >= 2)).toBe(true);
  });
  it('all points equal to sma -> no runs', () => {
    expect(zoneRuns([P(10, 10), P(10, 10), P(10, 10)])).toEqual([]);
  });
  it('null sma gaps break runs', () => {
    const r = zoneRuns([P(12, 10), P(13, null), P(14, 10), P(15, 10)]);
    console.log('NULLGAP', JSON.stringify(r));
    expect(r.length).toBe(1);
    expect(r[0].price.map((p) => p[0])).toEqual([2, 3]);
  });
  it('crossing is interpolated at the sma', () => {
    const r = zoneRuns([P(8, 10), P(12, 10)]);
    console.log('CROSS', JSON.stringify(r));
    expect(r.length).toBe(2);
    expect(r[0].over).toBe(false);
    expect(r[0].price[1]).toEqual([0.5, 10]);
    expect(r[1].price[0]).toEqual([0.5, 10]);
  });
  it('crossing with moving sma', () => {
    const r = zoneRuns([P(8, 10), P(14, 11)]);
    console.log('CROSS-MOVING-SMA', JSON.stringify(r));
  });
  it('touch then return to same side', () => {
    const r = zoneRuns([P(12, 10), P(10, 10), P(14, 10)]);
    console.log('TOUCH', JSON.stringify(r));
  });
  it('readings', () => {
    console.log(valueReading(undefined));
    console.log(valueReading({ price: 10, fair_value: null, date: 'x', sma200: null, zone: null, distance_pct: null, confirmation: null } as never));
    console.log(valueReading({ price: 10, fair_value: null, date: 'x', sma200: 10, zone: null, distance_pct: 0, confirmation: null } as never));
    console.log(valueReading({ price: 9, fair_value: null, date: 'x', sma200: 10, zone: 'infravalorada', distance_pct: -10, confirmation: { price: 8.5, basis: 'Fibonacci 0.618', distance_pct: -5.6 } } as never));
    console.log(valueReading({ price: 110, fair_value: null, date: 'x', sma200: 100, zone: 'sobrevalorada', distance_pct: 10, confirmation: null } as never));
    console.log(JSON.stringify(levelsInRange({ supports: [{ price: 95, basis: 'a' }, { price: 50, basis: 'b' }], resistances: [{ price: 105, basis: 'c' }] }, 100, 100)));
  });
});
