const recognition = require("./recognition");

const WORKER_MODE = process.env.RECOGNITION_WORKER_MODE || "local-process";

async function executeMatch({ descriptor, thresholdDistance, topK } = {}) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        const result = recognition.matchDescriptor({
          descriptor,
          thresholdDistance,
          topK,
        });

        resolve({
          ...result,
          workerMode: WORKER_MODE,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function getWorkerInfo() {
  return {
    mode: WORKER_MODE,
    engine: "descriptor-v1",
  };
}

module.exports = {
  executeMatch,
  getWorkerInfo,
};
