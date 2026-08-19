import { spawn } from "node:child_process";

/** Opens `url` in the default browser. Failures are silently discarded. */
export function openUrl(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // the report link is already printed; a browser is a nicety
  }
}
