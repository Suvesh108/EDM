export const formatBytes = (bytes: number): string => {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + " " + sizes[i];
};

export const formatSpeed = (bytesPerSec: number): string => {
  return formatBytes(bytesPerSec) + "/s";
};

export const formatEta = (seconds: number): string => {
  if (!seconds || seconds <= 0) return "Finished";
  if (seconds < 120) {
    // Under 2 minutes: round to nearest 5s
    const rounded = Math.max(5, Math.round(seconds / 5) * 5);
    if (rounded < 60) return `${rounded}s`;
    const mins = Math.floor(rounded / 60);
    const secs = rounded % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  // 2 minutes and above: round to nearest minute
  const roundedMins = Math.round(seconds / 60);
  if (roundedMins < 60) return `${roundedMins}m`;
  const hrs = Math.floor(roundedMins / 60);
  const remMins = roundedMins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
};
