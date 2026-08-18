export function probeAudioDurationMs(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const probe = document.createElement("audio");
    probe.preload = "metadata";
    probe.src = url;
    probe.onloadedmetadata = () => {
      const ms = Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0;
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
  });
}
