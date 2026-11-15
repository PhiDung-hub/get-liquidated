export type ApiAccess = { wallet: string; paid: true; keyPrefix: string; createdAt: number };
export const ACCESS_KEY_PATTERN = /^gl_(?:live|test)_[0-9a-f]{64}$/;
export const ACCESS_STORAGE = 'trade-ui:access-key';
const credential = $state<{ key: string | null; info: ApiAccess | null }>({ key: null, info: null });
let checkedStorage = false;

export function accessHeaders(): Record<string, string> {
  if (!checkedStorage) {
    checkedStorage = true;
    const saved = storedAccessKey();
    if (saved && ACCESS_KEY_PATTERN.test(saved)) credential.key = saved;
  }
  return credential.key ? { authorization: `Bearer ${credential.key}` } : {};
}

export const currentAccess = () => credential.info;
export const storedAccessKey = () => globalThis.localStorage?.getItem(ACCESS_STORAGE) ?? null;

export function setAccess(key: string, info: ApiAccess, remember: boolean) {
  if (!ACCESS_KEY_PATTERN.test(key)) throw new Error('API key format is invalid.');
  checkedStorage = true;
  credential.key = key;
  credential.info = info;
  if (remember) localStorage.setItem(ACCESS_STORAGE, key);
  else localStorage.removeItem(ACCESS_STORAGE);
}

export function forgetAccess() {
  checkedStorage = true;
  credential.key = null;
  credential.info = null;
  localStorage.removeItem(ACCESS_STORAGE);
}
