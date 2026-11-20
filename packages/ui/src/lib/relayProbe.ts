/** What checking a relay found: a route through it, or why there was none. */
export type RelayProbe = "works" | "refused" | "unreachable";

/**
 * Whether a TURN relay gives this computer a route, the way a call would ask:
 * a connection allowed only relayed routes gathers them, and one appearing
 * means the relay answered and took its username and password. The relay
 * answers a wrong password with 401, which is told apart from no answer.
 */
export async function probeRelay(iceServers: RTCIceServer[]): Promise<RelayProbe> {
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
  let refused = false;
  try {
    const found = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 10_000);
      const done = (works: boolean) => {
        clearTimeout(timer);
        resolve(works);
      };
      pc.addEventListener("icecandidate", (event) => {
        const candidate = event.candidate;
        // The end of gathering, with no relayed route among what came before.
        if (!candidate) done(false);
        else if (candidate.type === "relay" || / typ relay\b/.test(candidate.candidate)) done(true);
      });
      pc.addEventListener("icecandidateerror", (event) => {
        if ((event as RTCPeerConnectionIceErrorEvent).errorCode === 401) refused = true;
      });
    });
    // Something to offer, so the connection gathers routes at all.
    pc.createDataChannel("relay-check");
    await pc.setLocalDescription(await pc.createOffer());
    return (await found) ? "works" : refused ? "refused" : "unreachable";
  } finally {
    pc.close();
  }
}
