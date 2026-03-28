export function createCameraPresenceHelper({ emitEvent, getActiveCameras }) {
  const registerAll = () => {
    const cameras = getActiveCameras();
    cameras.forEach((camera) => {
      emitEvent("camera:register", {
        cameraId: camera.cameraId,
        cameraLabel: camera.cameraLabel,
        source: camera.source,
      });
    });
  };

  const disconnectAll = () => {
    const cameras = getActiveCameras();
    cameras.forEach((camera) => {
      emitEvent("camera:disconnect", {
        cameraId: camera.cameraId,
      });
    });
  };

  const handleUnload = () => {
    disconnectAll();
  };

  window.addEventListener("beforeunload", handleUnload);

  return {
    registerAll,
    disconnectAll,
    cleanup: () => {
      window.removeEventListener("beforeunload", handleUnload);
    },
  };
}
