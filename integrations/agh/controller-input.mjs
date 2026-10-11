/** JSONL plans exceed macOS PTY canonical line limits. Raw input disables truncation/echo;
 * readline still frames newline-delimited JSON, while Ctrl-C explicitly cancels the session. */
export function configureControllerInput(input, onCancel) {
  const raw = Boolean(input.isTTY && typeof input.setRawMode === 'function');
  const previous = Boolean(input.isRaw);
  if (raw) input.setRawMode(true);
  const onData = chunk => {
    if (Buffer.from(chunk).includes(3)) onCancel();
  };
  input.on('data', onData);
  return () => {
    input.removeListener('data', onData);
    if (raw) input.setRawMode(previous);
  };
}
