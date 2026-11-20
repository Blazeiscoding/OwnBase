import {
  CANDIDATE_KINDS,
  type CallReport,
  type CandidateCounts,
  type CandidateKind,
} from "@ownbase/protocol";

export const noCandidates = (): CandidateCounts => ({ host: 0, srflx: 0, prflx: 0, relay: 0 });

/** Whether `key` is new to `seen`, adding it. */
export function firstOf(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/** Which servers a configuration gives for finding routes, by kind. */
export function countServers(config: RTCConfiguration): { stun: number; turn: number } {
  let stun = 0;
  let turn = 0;
  for (const server of config.iceServers ?? []) {
    for (const url of [server.urls].flat()) {
      if (/^turns?:/i.test(url)) turn++;
      else if (/^stuns?:/i.test(url)) stun++;
    }
  }
  return { stun, turn };
}

export function describeServers(config: RTCConfiguration): string {
  const { stun, turn } = countServers(config);
  return `${stun} STUN and ${turn} TURN server${turn === 1 ? "" : "s"}${
    stun + turn === 0 ? " (direct routes on the same network only)" : ""
  }`;
}

export function describeCounts(counts: CandidateCounts): string {
  const found = CANDIDATE_KINDS.filter((kind) => counts[kind] > 0);
  return found.length ? found.map((kind) => `${counts[kind]} ${kind}`).join(", ") : "none";
}

/**
 * A route's kind and protocol, never its address: the log is meant to be
 * shared. Read from the browser's fields, or from the candidate line itself
 * ("candidate:… 1 udp 2122260223 192.0.2.1 54321 typ srflx …").
 */
export function candidateOf(candidate: {
  candidate?: string;
  type?: string | null;
  protocol?: string | null;
}): { kind: CandidateKind; protocol: "udp" | "tcp" } {
  const line = candidate.candidate ?? "";
  const type = candidate.type ?? /\btyp (\w+)/.exec(line)?.[1];
  const protocol = (candidate.protocol ?? line.split(" ")[2] ?? "").toLowerCase();
  return {
    kind: CANDIDATE_KINDS.includes(type as CandidateKind) ? (type as CandidateKind) : "host",
    protocol: protocol === "tcp" ? "tcp" : "udp",
  };
}

/** The route a connected call settled on, as the browser's statistics say. */
export async function selectedRoute(
  pc: RTCPeerConnection,
): Promise<(NonNullable<CallReport["route"]> & { rttMs: number | null }) | null> {
  if (typeof pc.getStats !== "function") return null;
  type Entry = {
    type: string;
    id: string;
    selectedCandidatePairId?: string;
    selected?: boolean;
    nominated?: boolean;
    state?: string;
    localCandidateId?: string;
    remoteCandidateId?: string;
    currentRoundTripTime?: number;
    candidateType?: string;
    protocol?: string;
  };
  const entries = new Map<string, Entry>();
  (await pc.getStats()).forEach((entry: Entry) => entries.set(entry.id, entry));
  const all = [...entries.values()];
  // Chrome and Safari name the pair on the transport; Firefox marks it selected.
  const pairId = all.find(
    (e) => e.type === "transport" && e.selectedCandidatePairId,
  )?.selectedCandidatePairId;
  const pair = all.find(
    (e) =>
      e.type === "candidate-pair" &&
      (pairId ? e.id === pairId : e.selected || (e.nominated && e.state === "succeeded")),
  );
  if (!pair) return null;
  const local = entries.get(pair.localCandidateId ?? "");
  const remote = entries.get(pair.remoteCandidateId ?? "");
  const kind = (type: string | undefined): CandidateKind =>
    CANDIDATE_KINDS.includes(type as CandidateKind) ? (type as CandidateKind) : "host";
  return {
    local: kind(local?.candidateType),
    remote: kind(remote?.candidateType),
    protocol: local?.protocol === "tcp" ? "tcp" : "udp",
    rttMs:
      typeof pair.currentRoundTripTime === "number"
        ? Math.round(pair.currentRoundTripTime * 1000)
        : null,
  };
}
