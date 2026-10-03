import { parentPort, workerData } from "node:worker_threads";

const queuedMessages = [];
let handlerReady = false;
globalThis.self = globalThis;
globalThis.postMessage = message => parentPort.postMessage(message);

parentPort.on("message", data => {
  if (!handlerReady) {
    queuedMessages.push(data);
    return;
  }
  dispatch(data);
});

await import(workerData.workerModuleUrl);
handlerReady = true;
for (const data of queuedMessages.splice(0)) dispatch(data);

function dispatch(data) {
  try {
    const result = globalThis.onmessage?.({ data });
    Promise.resolve(result).catch(reportError);
  } catch (error) {
    reportError(error);
  }
}

function reportError(error) {
  parentPort.postMessage({ type: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
}
