import { socket } from './ws.svelte';

export const info = <T = any>(payload: object, timeoutMs = 5000): Promise<T> => socket.post('info', payload, timeoutMs);
/** For the reads an order waits on: sent at once, even during a 429 hold. */
export const orderInfo = <T = any>(payload: object, timeoutMs = 5000): Promise<T> => socket.post('info', payload, timeoutMs, false);
