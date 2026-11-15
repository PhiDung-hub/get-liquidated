export function emitter<T>() {
  const subs = new Set<(v: T) => void>();
  return {
    on(f: (v: T) => void) {
      subs.add(f);
      return () => void subs.delete(f);
    },
    emit(v: T) {
      for (const f of subs) f(v);
    }
  };
}
