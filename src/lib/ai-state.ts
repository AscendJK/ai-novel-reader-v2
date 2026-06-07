let _aiRunning = false;
const _listeners = new Set<(running: boolean) => void>();

export function getAiRunning() {
  return _aiRunning;
}

export function setAiRunning(running: boolean) {
  _aiRunning = running;
  for (const fn of _listeners) fn(running);
}

export function onAiRunningChange(fn: (running: boolean) => void) {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}
