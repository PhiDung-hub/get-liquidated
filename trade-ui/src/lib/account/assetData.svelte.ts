import { num } from '$lib/util/parse';

export const assetData = $state({
  coin: '', leverage: null as { type: 'cross' | 'isolated'; value: number } | null,
  maxTradeSzs: [0, 0] as [number, number], availableToTrade: [0, 0] as [number, number]
});

export function applyAssetData(d: any) {
  Object.assign(assetData, {
    coin: d.coin,
    leverage: d.leverage ? { type: d.leverage.type === 'isolated' ? 'isolated' : 'cross', value: num(d.leverage.value, 'leverage') } : null,
    maxTradeSzs: [num(d.maxTradeSzs[0], 'maxTradeSzs'), num(d.maxTradeSzs[1], 'maxTradeSzs')],
    availableToTrade: [num(d.availableToTrade[0], 'availableToTrade'), num(d.availableToTrade[1], 'availableToTrade')]
  });
}
