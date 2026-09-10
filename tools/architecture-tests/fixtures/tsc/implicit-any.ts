// VIOLATION: implicit `any` parameter — caught by tsc noImplicitAny, not by lint.
export function add(a, b) {
  return a + b;
}
