import { ensurePayload, failureDetail } from "@bayma/core";

// `postinstall`, and a command anyone can run: put this version's payload in
// place so the first session does not wait for a download.

ensurePayload().catch((error: unknown) => {
  process.stderr.write(
    `bayma: the runtime payload could not be installed.\n${failureDetail(error)}\n` +
      "bayma will try again the first time it runs.\n",
  );
  // A failed download must not fail `npm install`; the server retries.
  process.exit(0);
});
