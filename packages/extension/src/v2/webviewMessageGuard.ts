/**
 * `onDidReceiveMessage` ignores whatever its listener returns. Every panel
 * here hands it an `async` method, so a handler that throws — a command id
 * that does not resolve, a bad path, a failed write — becomes an unhandled
 * rejection: the button click does nothing and nothing anywhere says why.
 * A missing `aidlcNative.` prefix on the run-gate commands hid behind
 * exactly that for the whole life of the pipeline runner.
 *
 * Wrapping the listener keeps its signature and makes the failure loud:
 * once in the output channel with the message type that caused it, once to
 * the user so they know the click was not simply ignored.
 */
import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function guardMessages<T extends { type?: unknown }>(
  handler: (msg: T) => unknown,
): (msg: T) => void {
  return (msg: T) => {
    const type = typeof msg?.type === 'string' ? msg.type : '(no type)';
    const fail = (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      channel ??= vscode.window.createOutputChannel('AIDLC Native · Webview');
      channel.appendLine(`[${new Date().toISOString()}] ${type} failed: ${reason}`);
      void vscode.window.showErrorMessage(`AIDLC: "${type}" failed — ${reason}`);
    };
    try {
      const result = handler(msg);
      if (result instanceof Promise) { void result.catch(fail); }
    } catch (err) {
      fail(err);
    }
  };
}
