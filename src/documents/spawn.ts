/**
 * Running one of the local document tools, with no shell between us and it.
 *
 * `ocr.ts` and `redact-image.ts` both drive system binaries — `pdftotext`,
 * `pdftoppm`, `tesseract`, `convert` — over bytes that came in on a request.
 * Two properties matter enough to have one implementation rather than two:
 *
 *  • **No shell, ever.** Every call is `spawn` with an argv array, so a
 *    filename or an OCR'd string can never become an argument, let alone a
 *    command. The tools take input on stdin or from a temp file we named.
 *  • **A hard deadline.** These run inside a request the caller is waiting
 *    on, and a tesseract that wedges on a bad page must fail the request
 *    rather than hold a connection until something upstream gives up.
 */
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Run a command with an argv array — never a shell — and a hard deadline. */
export function run(
  cmd: string,
  args: string[],
  opts: { input?: Buffer; timeoutMs: number },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${cmd} exceeded ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      // Bounded: tesseract is chatty on a bad page and an unbounded string
      // here would be a memory leak driven by input we do not control.
      if (err.length < 4096) err += d.toString();
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT means the binary is missing from the machine — a deployment
      // fault, not a bad document, and the message says so because the two
      // get diagnosed very differently.
      reject(
        (e as NodeJS.ErrnoException).code === "ENOENT"
          ? new Error(`${cmd} is not installed on this machine`)
          : e,
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });

    if (opts.input) {
      // EPIPE is normal here: pdftotext can decide it has read enough and
      // close stdin while we are still writing. Crashing over it would be a
      // self-inflicted outage on a perfectly good document.
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Is a binary present on this machine? Used by availability reports. */
export async function toolPresent(cmd: string, args: string[]): Promise<boolean> {
  try {
    await run(cmd, args, { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}
