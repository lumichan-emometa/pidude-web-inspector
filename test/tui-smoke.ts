// Opt-in companion for a real Pi TUI smoke test. Never sends a model prompt.
// pi -ne -e ./src/index.ts -e ./test/tui-smoke.ts --no-session
// /smoke-fixture prints its loopback URL. /smoke-watch records the editor draft;
// POST /trigger to that fixture after positioning the caret to test real insertion.
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let server: Server | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  pi.registerCommand("smoke-fixture", {
    description: "Start a local synthetic picker fixture (test only)",
    async handler(_args, ctx) {
      if (server) return;
      let trigger = false;
      server = createServer((req, res) => {
        if (req.url === "/trigger") {
          if (req.method === "POST") trigger = true;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ trigger }));
          return;
        }
        res.setHeader("Content-Type", "text/html");
        res.end(`<!doctype html><html><body><h1>Pi TUI smoke test</h1><button id="target">Start free</button><script>
          const timer=setInterval(async()=>{
            const {trigger}=await fetch('/trigger').then(r=>r.json());
            const picker=document.querySelector('pidude-web-inspector')?.shadowRoot;
            if(!trigger || !picker) return;
            clearInterval(timer);
            picker.querySelector('#select').click();
            document.querySelector('#target').click();
            picker.querySelector('#insert').click();
          },200);
        </script></body></html>`);
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address && typeof address !== "string") {
        const url = `http://127.0.0.1:${address.port}`;
        mkdirSync("artifacts", { recursive: true });
        writeFileSync("artifacts/tui-smoke-url.txt", url);
        ctx.ui.notify(`Smoke fixture: ${url}`, "info");
      }
    },
  });
  pi.registerCommand("smoke-watch", {
    description: "Record current draft into artifacts/tui-draft.txt (test only)",
    async handler(_args, ctx) {
      clearInterval(timer);
      mkdirSync("artifacts", { recursive: true });
      timer = setInterval(() => writeFileSync("artifacts/tui-draft.txt", ctx.ui.getEditorText()), 200);
    },
  });
  pi.on("session_shutdown", async () => {
    clearInterval(timer);
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
  });
}
