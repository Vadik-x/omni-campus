let faceEnginePromise = null;

export async function getFaceEngine() {
  if (!faceEnginePromise) {
    faceEnginePromise = import("./faceEngine").then((module) => module.faceEngine);
  }

  return faceEnginePromise;
}